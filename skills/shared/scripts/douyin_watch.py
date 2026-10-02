#!/usr/bin/env python3
"""douyin_watch.py — 登录态抓取任意抖音博主的最新作品 / 当前账号的收藏（自选博主追更、收藏面板用）。

原理：用发布流程同款**持久化登录 profile**（launch_persistent_context，真实浏览器指纹）
打开目标页，**旁听页面自己发出的**列表 XHR（页面自带合法 a_bogus 签名），解析 aweme_list：
  fetch   → 打开 `www.douyin.com/user/<sec_uid>`，旁听 `/aweme/v1/web/aweme/post/`
  collect → 打开自己主页的收藏 tab（user/self?showTab=favorite_collection），
            旁听 `/aweme/v1/web/aweme/listcollection/`
不做裸 API 直调（需签名）、不依赖 RSSHub（实测被抖音 WAF 拦：游客会话 API 返回空 body，
且当前 RSSHub 抖音路由不支持配 Cookie）。

退出码：0 成功；2 参数错；5 图文/无音轨（仅 download）；6 超时未取到数据；
7 下载失败（仅 download）；8 未登录抖音（引导先在 Web「账号」页登录）。
输出：JSON {"count", "has_more", "new_count", "items":[{title,url,created,duration,digg,comment,share,author,cover,feed}]}
（字段命名与 rss_digest.py 的 digest 契约对齐，供 web watchlist/digest 与 SKILL 消费）。
fetch 模式额外带 "author_stats": {follower_count, aweme_count}——旁听博主主页自己的
profile/other XHR 得到，页面本来就会发，零额外代价；拿不到（风控/没发）则不带该键。

download 模式（单个视频 → mp4，供「做内容」转写视频语音/当素材）输出：
    {"path", "size", "duration_ms", "id"}——stdout 一行 JSON，进度类信息全走 stderr。

分页：抖音 a_bogus 签名在页面里算，无法自己构造第 N 页请求，**只能真实滚动让页面自己发下一页
XHR**。所以深度加载靠 --want N（要相对已看集合新增 N 条）驱动持续滚动，代价随已看条数线性
增长（第 N 页 ≈ N×2s 滚动 + 一次浏览器启动）。--seen-file 给已看 aweme_id 集合，滚动到「新增
够 want」/「has_more=false」/「连续 3 轮滚不动」/ 超时 任一即停；want>0 时返回条数上限自动
抬到「len(seen)+want」，保证要找的旧条目不被 merge 截掉。

用法：
    python douyin_watch.py fetch --uid MS4wLjABAAAA... [--limit 10] [--format json] [-o out.json]
    python douyin_watch.py collect [--limit 20] [--format json] [-o out.json]   # 当前账号收藏
    python douyin_watch.py download --url https://www.douyin.com/video/<id> -o out.mp4
    # 增量：已看 ids 落盘，滚到多 30 条新内容为止
    python douyin_watch.py collect --want 30 --seen-file seen.json
    python douyin_watch.py check                     # 只检查登录态
    python douyin_watch.py selftest                  # 离线自检（归一化/去重/排序/增量）
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

UID_PREFIX = "MS4wLjABAAAA"
UID_RE = re.compile(r"douyin\.com/user/(" + UID_PREFIX + r"[A-Za-z0-9_-]+)|^(" + UID_PREFIX + r"[A-Za-z0-9_-]+)$")
API_RE = re.compile(r"aweme/v1/web/aweme/post/")
PROFILE_API_RE = re.compile(r"aweme/v1/web/user/profile/other/")
COLLECT_API_RE = re.compile(r"aweme/v1/web/aweme/listcollection/")
DETAIL_API_RE = re.compile(r"aweme/v1/web/aweme/detail/")   # 单视频页加载必发的详情 XHR
COLLECT_URL = "https://www.douyin.com/user/self?showTab=favorite_collection"

LAUNCH_ARGS = [
    "--disable-blink-features=AutomationControlled",
    "--no-sandbox", "--disable-gpu", "--disable-software-rasterizer",
    "--disable-extensions", "--disable-background-networking",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-features=TranslateUI,BackForwardCache",
    "--mute-audio", "--no-first-run", "--no-default-browser-check",
]

TZ = timezone(timedelta(hours=8))  # 抖音面向国内，统一按东八区展示


def _die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def _profile_dir(base: str | None) -> Path:
    root = Path(base).expanduser() if base else Path.home() / ".easel-browser-profiles"
    return root / "DouyinProfile"


def _extract_uid(text: str) -> str:
    """从裸 sec_uid 或用户主页链接提取 uid。"""
    m = UID_RE.search((text or "").strip())
    if not m:
        _die(f"无法从「{(text or '')[:60]}」识别抖音博主 sec_uid（应以 {UID_PREFIX} 开头，"
             f"或粘贴 douyin.com/user/… 主页链接）", 2)
    return m.group(1) or m.group(2)


def _logged_in(ctx) -> bool:
    """douyin.com 域下存在 sessionid（或其_ss 变体）即认为有登录会话。"""
    names = {c["name"] for c in ctx.cookies("https://www.douyin.com")}
    return bool(names & {"sessionid", "sessionid_ss", "sid_tt"})


def _normalize(aweme_list: list[dict], feed: str = "") -> list[dict]:
    """aweme_list → 统一条目。纯函数，selftest 覆盖。

    收藏列表（listcollection）元素可能是 {"aweme_info": {...}, "collect_time": …} 的
    包装，这里一并拆包；有 collect_time（收藏时间）时优先按它展示/排序（收藏夹的
    时间轴是"什么时候存的"）。"""
    items: list[dict] = []
    for raw in aweme_list:
        if not isinstance(raw, dict):
            continue
        it = raw.get("aweme_info") if isinstance(raw.get("aweme_info"), dict) else raw
        if not it.get("aweme_id"):
            continue
        stats = it.get("statistics") or {}
        # collect_time 挂在包装层（raw）上，拆包后要回外层取
        ts = raw.get("collect_time") or it.get("collect_time") or it.get("create_time")
        video = it.get("video") or {}
        cover = ((video.get("cover") or {}).get("url_list") or [""])[0]
        items.append({
            "title": (it.get("desc") or "").strip() or "(无文案)",
            "url": f"https://www.douyin.com/video/{it['aweme_id']}",
            "created": datetime.fromtimestamp(int(ts), TZ).isoformat() if ts else "",
            "duration": int((video.get("duration") or 0) / 1000) or None,  # ms → s
            "digg": stats.get("digg_count"),
            "comment": stats.get("comment_count"),
            "share": stats.get("share_count"),
            "cover": cover,
            "author": ((it.get("author") or {}).get("nickname") or "").strip(),
            "feed": feed,
        })
    return items


def _merge(hits: list[list[dict]], limit: int) -> list[dict]:
    """多次 API 命中合并：按 aweme_id 去重、按时间倒序、截 limit。"""
    seen: set[str] = set()
    flat: list[dict] = []
    for lst in hits:
        for it in lst:
            if it["url"] in seen:
                continue
            seen.add(it["url"])
            flat.append(it)
    flat.sort(key=lambda x: x["created"], reverse=True)
    return flat[:limit]


def _aweme_id(url: str) -> str:
    """https://www.douyin.com/video/<id> → <id>（已看集合按 id 比对，URL 太长不适合做键）。"""
    return (url or "").rsplit("/", 1)[-1]


def _load_seen(path: str | None) -> set[str]:
    """读已看 aweme_id 集合（--seen-file）。纯 JSON 数组；缺失/损坏按「没看过」处理，不报错。"""
    if not path:
        return set()
    try:
        data = json.loads(Path(path).expanduser().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return set()
    if not isinstance(data, list):
        return set()
    return {str(x) for x in data if isinstance(x, (str, int)) and str(x)}


def _new_ids(items: list[dict], seen: set[str] | None) -> set[str]:
    """本批条目里相对「已看集合」的新增 aweme_id。

    水位语义：按 **ID 集合** 记，不按页码/深度记 —— 抖音是时间倒序，新视频插到列表前面，
    按页码记会漏掉插入的新内容，也没法判断「哪条已经看过了」。纯函数，selftest 覆盖。
    """
    return {_aweme_id(it["url"]) for it in items} - (seen or set())


def _parse_profile(d) -> dict:
    """profile/other 响应 → 博主统计 {follower_count, aweme_count}。纯函数，selftest 覆盖。

    只收非负整数，其余形态（缺字段/字符串/负数）一律丢弃——宁可没有也别给错的。"""
    try:
        u = (d or {}).get("user")
    except AttributeError:
        return {}
    if not isinstance(u, dict):
        return {}
    out = {}
    for k in ("follower_count", "aweme_count"):
        v = u.get(k)
        if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
            out[k] = v
    return out


def _pick_play_url(detail: dict) -> str:
    """aweme_detail → 无水印播放地址。play_addr 优先，bit_rate 多码率逐个兜底；
    都没有（图文帖/无 video 字段）返回空串。纯函数，selftest 覆盖。"""
    v = (detail or {}).get("video") or {}
    for u in ((v.get("play_addr") or {}).get("url_list") or []):
        if u:
            return u
    for br in v.get("bit_rate") or []:
        for u in (((br or {}).get("play_addr") or {}).get("url_list") or []):
            if u:
                return u
    return ""


def _wait_items(page, deadline: float, api_re=API_RE, per_author: bool = False,
                want: int = 0, seen: set[str] | None = None
                ) -> tuple[list[list[dict]], str, bool]:
    """累积式深度滚动：滚到「相对 seen 新增够 want 条」/「has_more=false」/「连续 3 轮滚不动」
    / 超时 任一即停，返回 (各页命中, feed 标题, 是否还有更多)。

    per_author=False（博主作品页）：顺带从首个命中取博主昵称（author.nickname）作 feed 标题。
    per_author=True（收藏列表，跨博主）：feed 逐条取各视频自己的作者昵称。

    want=0 兼容旧行为：拿到首批就返回。空 body（游客/风控软拦）时持续滚动触发重试直至超时。
    """
    hits: list[list[dict]] = []
    seen = seen or set()
    has_more = True          # 响应没带 has_more 时宁可多给入口，也不假装到底了
    feed_title = ""
    idle = 0
    last_fresh = -1

    def on_response(resp):
        nonlocal feed_title, has_more
        if not api_re.search(resp.url):
            return
        try:
            d = resp.json()
            if not isinstance(d, dict):
                return
            if d.get("has_more") is False:
                has_more = False
            lst = d.get("aweme_list") or []
            if not lst:
                return
            if per_author:
                norm = _normalize(lst)
                for it in norm:
                    it["feed"] = it["author"]
                hits.append(norm)
            else:
                if not feed_title:
                    feed_title = ((lst[0].get("author") or {}).get("nickname") or "").strip()
                hits.append(_normalize(lst, feed_title))
        except Exception:
            pass  # 200 空 body —— 留在循环里继续滚动重试

    page.on("response", on_response)
    while time.time() < deadline:
        fresh = len({_aweme_id(it["url"]) for lst in hits for it in lst} - seen)
        if want:
            if fresh >= want:
                break                      # 新增量够数，收工
        elif hits:
            break                          # want=0：只要首批（旧行为）
        if hits and not has_more:
            break                          # 服务端明确说到底了
        if hits and fresh == last_fresh:
            idle += 1
            if idle >= 3:
                break                      # 连续 ~6s 滚不动，判底
        else:
            idle = 0
        last_fresh = fresh
        try:
            page.mouse.wheel(0, 2600)       # 触发 loadmore / 首屏重试
        except Exception:
            pass
        time.sleep(2.0)
    return hits, feed_title, has_more


def _listen_once(url: str, api_re, per_author: bool, limit: int, timeout: int,
                 headed: bool, profile_base: str | None,
                 want: int = 0, seen: set[str] | None = None, capture_profile: bool = False
                 ) -> tuple[list[dict], bool, int, dict]:
    """持久化登录 profile 打开页面，深度滚动到目标增量并返回 (条目, has_more, 新增数, 博主统计)。

    profile 缺失 / 未登录分别 exit 8（引导去「账号」页登录）；返回空列表=超时未截到。
    capture_profile=True（博主作品页）：顺带旁听主页自己发的 profile/other XHR，
    拿粉丝数/作品数——页面本来就会发这个请求，零额外翻页代价；拿不到返回 {}。"""
    from playwright.sync_api import sync_playwright

    author_stats: dict = {}

    def on_profile(resp):
        if not PROFILE_API_RE.search(resp.url):
            return
        try:
            parsed = _parse_profile(resp.json())
        except Exception:
            return
        if parsed:
            author_stats.clear()
            author_stats.update(parsed)

    with sync_playwright() as p:
        profile = _profile_dir(profile_base)
        if not profile.exists():
            _die(f"抖音浏览器 profile 不存在（{profile}）——请先在 Web「账号」页登录抖音", 8)
        ctx = p.chromium.launch_persistent_context(
            str(profile), headless=not headed, locale="zh-CN",
            args=list(LAUNCH_ARGS) + ["--no-proxy-server"])  # 国内平台必须直连
        try:
            if not _logged_in(ctx):
                _die("抖音未登录（profile 无 sessionid）——请先在 Web「账号」页登录抖音后重试", 8)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            if capture_profile:
                page.on("response", on_profile)   # 挂在 goto 前，主页 XHR 一个都不漏
            page.goto(url, wait_until="commit", timeout=30000)
            hits, _, has_more = _wait_items(page, time.time() + timeout, api_re,
                                            per_author, want, seen)
            items = _merge(hits, limit)
            return items, has_more, len(_new_ids(items, seen)), dict(author_stats)
        finally:
            ctx.close()


def _emit(items: list[dict], output: str | None, with_feed: bool = True,
          has_more: bool = True, new_count: int | None = None,
          extra: dict | None = None) -> None:
    payload: dict = {
        "count": len(items),
        "has_more": has_more,
        "new_count": len(items) if new_count is None else new_count,
    }
    if with_feed:
        payload["feed"] = items[0]["feed"] if items else ""
    if extra:
        payload.update(extra)
    payload["items"] = items
    content = json.dumps(payload, ensure_ascii=False, indent=2)
    if output:
        out = Path(output).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8")
        print(f"✅ {out}（本次 {len(items)} 条 / 新增 {payload['new_count']} 条"
              f"{'，还有更多' if has_more else '，已到底'}）")
    else:
        print(content)


def cmd_fetch(a) -> int:
    uid = _extract_uid(a.uid or a.url or "")
    want = max(0, a.want)
    seen = _load_seen(a.seen_file)
    # want>0 时 limit 要给足：滚动会从第一页累积「已看集合 + 本次增量」，merge 按时间倒序
    # 截 limit，本次要找的旧条目排在最末——limit 盖不住 len(seen)+want 时它们会被截掉
    limit = max(1, min(a.limit, 30)) if not want else max(60, want * 3, len(seen) + want)
    items, has_more, new_count, stats = _listen_once(
        f"https://www.douyin.com/user/{uid}", API_RE, False,
        limit, a.timeout, a.headed, a.profile_base, want, seen, capture_profile=True)
    if not items:
        _die(f"超时（{a.timeout}s）未截到作品数据——抖音风控可能拦了本次会话，稍后重试", 6)
    _emit(items, a.output, has_more=has_more, new_count=new_count,
          extra={"author_stats": stats} if stats else None)
    return 0


def cmd_collect(a) -> int:
    """拉当前登录账号的收藏视频：打开自己主页收藏 tab，深度滚动旁听 listcollection XHR。"""
    want = max(0, a.want)
    seen = _load_seen(a.seen_file)
    limit = max(1, min(a.limit, 30)) if not want else max(60, want * 3, len(seen) + want)
    items, has_more, new_count, _ = _listen_once(
        COLLECT_URL, COLLECT_API_RE, True,
        limit, a.timeout, a.headed, a.profile_base, want, seen)
    if not items:
        _die(f"超时（{a.timeout}s）未截到收藏数据——请确认账号下有收藏，"
             f"或稍后重试（可能被风控软拦）", 6)
    _emit(items, a.output, with_feed=False, has_more=has_more, new_count=new_count)
    return 0


def cmd_download(a) -> int:
    """下载单个视频：打开视频页旁听 detail XHR 拿 play_addr（页面自带合法签名，不自己
    构造请求），再用 ctx.request（与页面共享登录 cookie/UA，自动跟随 302 到 CDN）拉流。
    供「做内容」链路转写视频语音、或当创作素材。stdout 输出一行 JSON 结果，进度走 stderr。
    退出码：5=图文/无音轨；6=超时未截到播放地址；7=下载失败；其余见文件头退出码约定。"""
    if not re.search(r"douyin\.com/video/\d+", a.url or ""):
        _die("仅支持抖音视频页链接（douyin.com/video/<id>）", 2)
    out = Path(a.output).expanduser() if a.output else None
    if not out:
        _die("必须用 -o 指定保存路径", 2)
    from playwright.sync_api import sync_playwright

    seen: dict = {}   # url/duration_ms = 播放地址与时长；detail = 已见过详情 XHR（区分图文与风控）

    def on_detail(resp):
        if not DETAIL_API_RE.search(resp.url):
            return
        try:
            d = resp.json()
        except Exception:
            return
        det = d.get("aweme_detail") if isinstance(d, dict) else None
        if not isinstance(det, dict):
            return
        seen["detail"] = True
        u = _pick_play_url(det)
        if u:
            seen["url"] = u
            seen["duration_ms"] = ((det.get("video") or {}).get("duration")) or None

    with sync_playwright() as p:
        profile = _profile_dir(a.profile_base)
        if not profile.exists():
            _die(f"抖音浏览器 profile 不存在（{profile}）——请先在 Web「账号」页登录抖音", 8)
        ctx = p.chromium.launch_persistent_context(
            str(profile), headless=not a.headed, locale="zh-CN",
            args=list(LAUNCH_ARGS) + ["--no-proxy-server"])  # 国内平台必须直连
        try:
            if not _logged_in(ctx):
                _die("抖音未登录（profile 无 sessionid）——请先在 Web「账号」页登录抖音后重试", 8)
            page = ctx.pages[0] if ctx.pages else ctx.new_page()
            page.on("response", on_detail)   # 挂在 goto 前，详情 XHR 一个不漏
            try:
                page.goto(a.url, wait_until="commit", timeout=30000)
            except Exception:
                _die("打开视频页失败——链接无效或网络受限", 6)
            deadline = time.time() + a.timeout
            while time.time() < deadline and "url" not in seen:
                time.sleep(0.5)
                try:
                    page.mouse.wheel(0, 1200)   # 触发播放器加载（详情 XHR 通常首屏就发）
                except Exception:
                    pass
            if "url" not in seen:
                hint = "该内容可能是图文帖（无音轨可转）" if seen.get("detail") else "可能被风控软拦"
                _die(f"超时（{a.timeout}s）未截到视频播放地址——{hint}，或稍后重试", 6)
            resp = ctx.request.get(seen["url"], headers={"Referer": "https://www.douyin.com/"},
                                   timeout=120_000)
            if not resp.ok:
                _die(f"视频下载失败：HTTP {resp.status}", 7)
            body = resp.body()
            if len(body) < 100_000:   # 正常视频至少几百 KB；过小基本是风控页/空响应
                _die(f"下载内容仅 {len(body)} 字节，疑似风控拦截页", 7)
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_bytes(body)
        finally:
            ctx.close()
    print(json.dumps({"path": str(out), "size": len(body), "id": _aweme_id(a.url),
                      "duration_ms": seen.get("duration_ms")}, ensure_ascii=False))
    return 0


def cmd_check(a) -> int:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        profile = _profile_dir(a.profile_base)
        if not profile.exists():
            print(f"NOT_LOGGED_IN profile 不存在: {profile}")
            return 8
        ctx = p.chromium.launch_persistent_context(
            str(profile), headless=True, locale="zh-CN",
            args=list(LAUNCH_ARGS) + ["--no-proxy-server"])
        try:
            ok = _logged_in(ctx)
        finally:
            ctx.close()
    print("LOGGED_IN" if ok else "NOT_LOGGED_IN")
    return 0 if ok else 8


def cmd_selftest(_a) -> int:
    now = int(time.time())
    fixture = [
        {"aweme_id": "7300000000000000002", "desc": "第二条", "create_time": now - 60,
         "statistics": {"digg_count": 2, "comment_count": 0, "share_count": 0},
         "video": {"duration": 15234, "cover": {"url_list": ["http://c/2.jpg"]}}},
        {"aweme_id": "7300000000000000001", "desc": "第一条", "create_time": now,
         "statistics": {"digg_count": 1, "comment_count": 3, "share_count": 4},
         "video": {"duration": 8000, "cover": {"url_list": ["http://c/1.jpg"]}}},
        {"aweme_id": "7300000000000000001", "desc": "重复应被去重", "create_time": now},
        {"desc": "无 id 应被丢弃"},
    ]
    items = _merge([_normalize(fixture, "测试博主")], 10)
    assert len(items) == 2, f"去重/过滤失败: {len(items)}"
    assert items[0]["title"] == "第一条" and items[0]["created"] > items[1]["created"], "排序失败"
    assert items[0]["url"].endswith("7300000000000000001")
    assert items[0]["duration"] == 8 and items[1]["duration"] == 15, "时长换算失败"
    assert items[0]["feed"] == "测试博主", "feed 透传失败"
    uid = _extract_uid("https://www.douyin.com/user/MS4wLjABAAAAabcdefgh1234567890abcdefghij12")
    assert uid == "MS4wLjABAAAAabcdefgh1234567890abcdefghij12", "uid 提取失败"

    # 收藏列表形态：aweme_info 包装 + collect_time（收藏时间）优先 + author 提取
    wrapped = [
        {"aweme_info": {"aweme_id": "7300000000000000005", "desc": "  ", "create_time": now,
                        "author": {"nickname": " 收藏作者A "},
                        "video": {"duration": 0, "cover": {"url_list": ["http://c/5.jpg"]}}},
         "collect_time": now - 5},
        {"aweme_info": {"aweme_id": "7300000000000000004", "desc": "收藏B", "create_time": now,
                        "video": {}}, "collect_time": now},
        {"aweme_id": "7300000000000000003", "desc": "非包装也应兼容", "create_time": now + 10},
    ]
    col = _merge([_normalize(wrapped, "")], 10)
    assert col[0]["url"].endswith("7300000000000000003"), "非包装兼容失败"
    assert col[1]["created"] == datetime.fromtimestamp(now, TZ).isoformat(), "collect_time 优先失败"
    assert col[2]["title"] == "(无文案)", "空文案兜底失败"
    assert col[2]["author"] == "收藏作者A", "author 提取失败"

    # ---- 分页/水位：aweme_id 提取、已看集合读写、增量计数 ----
    assert _aweme_id("https://www.douyin.com/video/7300000000000000001") == "7300000000000000001"
    # ---- 博主统计：profile/other 解析，非负整数才收 ----
    assert _parse_profile({"user": {"follower_count": 12345, "aweme_count": 67}}) == {
        "follower_count": 12345, "aweme_count": 67}, "profile 统计解析失败"
    assert _parse_profile({"user": {}}) == {}, "空 user 应给空统计"
    assert _parse_profile(None) == {} and _parse_profile({}) == {}, "缺响应应容错"
    assert _parse_profile({"user": {"follower_count": "1.2万", "aweme_count": -1}}) == {}, \
        "非整数/负数应丢弃"
    # ---- download：play_addr 提取（play_addr 优先、bit_rate 兜底、图文给空） ----
    assert _pick_play_url({"video": {"play_addr": {"url_list": ["", "https://x/p.mp4"]}}}) == \
        "https://x/p.mp4", "play_addr 空项应跳过"
    assert _pick_play_url({"video": {"bit_rate": [
        {"play_addr": {"url_list": []}}, {"play_addr": {"url_list": ["https://x/br.mp4"]}}]}}) == \
        "https://x/br.mp4", "bit_rate 兜底失败"
    assert _pick_play_url({"video": {}}) == "" and _pick_play_url({"images": []}) == "", \
        "图文/无 video 应给空串"
    assert _new_ids(col, set()) == {_aweme_id(it["url"]) for it in col}, "空水位应全算新增"
    # 已看前两条 → 只剩第 3 条算新增（这正是「再看 30 条」判定增量的口径）
    seen = {_aweme_id(col[1]["url"]), _aweme_id(col[2]["url"])}
    assert _new_ids(col, seen) == {_aweme_id(col[0]["url"])}, "增量口径错"
    # 新视频插到时间线最前面时，已看集合仍能正确识别哪些是新的（不依赖顺序/页码）
    inserted = [{"url": "https://www.douyin.com/video/9990000000000000001"}] + col
    assert _new_ids(inserted, seen) == {"9990000000000000001", _aweme_id(col[0]["url"])}, "插入场景错"

    import tempfile
    with tempfile.TemporaryDirectory() as td:
        sf = Path(td) / "seen.json"
        sf.write_text(json.dumps(["7300000000000000001", 7300000000000000002]), encoding="utf-8")
        assert _load_seen(str(sf)) == {"7300000000000000001", "7300000000000000002"}, "已看集合读取失败"
        bad = Path(td) / "bad.json"
        bad.write_text("{不是 json", encoding="utf-8")
        assert _load_seen(str(bad)) == set(), "损坏文件应按空水位容错"
        assert _load_seen(None) == set() and _load_seen(str(Path(td) / "nope.json")) == set(), "缺失文件应容错"

    print("✅ selftest 通过（归一化/去重/排序/时长换算/uid 提取/收藏拆包与 collect_time"
          "/aweme_id 提取/已看集合读写/增量水位/profile 统计解析/play_addr 提取）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="登录态抓取抖音博主最新作品")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("fetch", help="抓取最新作品 → JSON")
    p.add_argument("--uid", help="博主 sec_uid（MS4wLjABAAAA 开头）")
    p.add_argument("--url", help="或博主主页链接 douyin.com/user/…")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--want", type=int, default=0,
                   help="要相对 --seen 新增多少条（>0 触发深度滚动）")
    p.add_argument("--seen-file", default=None, help="已看 aweme_id 的 JSON 数组文件")
    p.add_argument("--format", choices=["json"], default="json")
    p.add_argument("--timeout", type=int, default=90, help="总等待秒数")
    p.add_argument("--headed", action="store_true", help="有头模式（排障用）")
    p.add_argument("--profile-base", default=None, help="浏览器 profile 根目录")
    p.add_argument("-o", "--output", help="输出路径")
    p.set_defaults(func=cmd_fetch)

    c = sub.add_parser("collect", help="抓当前登录账号的收藏视频 → JSON")
    c.add_argument("--limit", type=int, default=20)
    c.add_argument("--want", type=int, default=0,
                   help="要相对 --seen 新增多少条（>0 触发深度滚动）")
    c.add_argument("--seen-file", default=None, help="已看 aweme_id 的 JSON 数组文件")
    c.add_argument("--format", choices=["json"], default="json")
    c.add_argument("--timeout", type=int, default=90, help="总等待秒数")
    c.add_argument("--headed", action="store_true", help="有头模式（排障用）")
    c.add_argument("--profile-base", default=None, help="浏览器 profile 根目录")
    c.add_argument("-o", "--output", help="输出路径")
    c.set_defaults(func=cmd_collect)

    c2 = sub.add_parser("check", help="只检查登录态")
    c2.add_argument("--profile-base", default=None)
    c2.set_defaults(func=cmd_check)

    d = sub.add_parser("download", help="下载单个视频 → mp4（供转写语音/素材用）")
    d.add_argument("--url", required=True, help="视频页链接 douyin.com/video/<id>")
    d.add_argument("-o", "--output", required=True, help="保存路径（.mp4）")
    d.add_argument("--timeout", type=int, default=45, help="等待播放地址的秒数")
    d.add_argument("--headed", action="store_true", help="有头模式（排障用）")
    d.add_argument("--profile-base", default=None, help="浏览器 profile 根目录")
    d.set_defaults(func=cmd_download)

    sub.add_parser("selftest", help="离线自检").set_defaults(func=cmd_selftest)

    a = ap.parse_args()
    if not getattr(a, "func", None):
        ap.print_help()
        return 1
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
