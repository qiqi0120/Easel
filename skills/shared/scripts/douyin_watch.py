#!/usr/bin/env python3
"""douyin_watch.py — 登录态抓取任意抖音博主的最新作品 / 当前账号的收藏（自选博主追更、收藏面板用）。

原理：用发布流程同款**持久化登录 profile**（launch_persistent_context，真实浏览器指纹）
打开目标页，**旁听页面自己发出的**列表 XHR（页面自带合法 a_bogus 签名），解析 aweme_list：
  fetch   → 打开 `www.douyin.com/user/<sec_uid>`，旁听 `/aweme/v1/web/aweme/post/`
  collect → 打开自己主页的收藏 tab（user/self?showTab=favorite_collection），
            旁听 `/aweme/v1/web/aweme/listcollection/`
不做裸 API 直调（需签名）、不依赖 RSSHub（实测被抖音 WAF 拦：游客会话 API 返回空 body，
且当前 RSSHub 抖音路由不支持配 Cookie）。

退出码：0 成功；2 参数错；6 超时未取到数据；8 未登录抖音（引导先在 Web「账号」页登录）。
输出：JSON {"count": N, "items": [{title,url,created,duration,digg,comment,share,author,cover,feed}]}
（字段命名与 rss_digest.py 的 digest 契约对齐，供 web watchlist/digest 与 SKILL 消费）。

用法：
    python douyin_watch.py fetch --uid MS4wLjABAAAA... [--limit 10] [--format json] [-o out.json]
    python douyin_watch.py collect [--limit 20] [--format json] [-o out.json]   # 当前账号收藏
    python douyin_watch.py check                     # 只检查登录态
    python douyin_watch.py selftest                  # 离线自检（归一化/去重/排序）
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
COLLECT_API_RE = re.compile(r"aweme/v1/web/aweme/listcollection/")
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


def _wait_items(page, deadline: float, api_re=API_RE, per_author: bool = False) -> tuple[list[list[dict]], str]:
    """收集目标 API 命中；空 body（游客/风控软拦）时持续滚动触发重试直至超时。

    per_author=False（博主作品页）：顺带从首个命中取博主昵称（author.nickname）作 feed 标题。
    per_author=True（收藏列表，跨博主）：feed 逐条取各视频自己的作者昵称。"""
    hits: list[list[dict]] = []
    feed_title = ""

    def on_response(resp):
        nonlocal feed_title
        if not api_re.search(resp.url):
            return
        try:
            d = resp.json()
            lst = d.get("aweme_list") or []
            if lst:
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
        if hits:
            return hits, feed_title
        try:
            page.mouse.wheel(0, 2600)  # 触发 loadmore / 首屏重试
        except Exception:
            pass
        time.sleep(2.0)
    return hits, feed_title


def _listen_once(url: str, api_re, per_author: bool, limit: int, timeout: int,
                 headed: bool, profile_base: str | None) -> list[dict]:
    """持久化登录 profile 打开页面，旁听首个目标 API 命中并合并返回。

    profile 缺失 / 未登录分别 exit 8（引导去「账号」页登录）；返回空列表=超时未截到。"""
    from playwright.sync_api import sync_playwright

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
            page.goto(url, wait_until="commit", timeout=30000)
            hits, _ = _wait_items(page, time.time() + timeout, api_re, per_author)
            return _merge(hits, limit)
        finally:
            ctx.close()


def _emit(items: list[dict], output: str | None, with_feed: bool = True) -> None:
    payload: dict = {"count": len(items)}
    if with_feed:
        payload["feed"] = items[0]["feed"] if items else ""
    payload["items"] = items
    content = json.dumps(payload, ensure_ascii=False, indent=2)
    if output:
        out = Path(output).expanduser()
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(content, encoding="utf-8")
        print(f"✅ {out}（{len(items)} 条）")
    else:
        print(content)


def cmd_fetch(a) -> int:
    uid = _extract_uid(a.uid or a.url or "")
    items = _listen_once(f"https://www.douyin.com/user/{uid}", API_RE, False,
                         max(1, min(a.limit, 30)), a.timeout, a.headed, a.profile_base)
    if not items:
        _die(f"超时（{a.timeout}s）未截到作品数据——抖音风控可能拦了本次会话，稍后重试", 6)
    _emit(items, a.output)
    return 0


def cmd_collect(a) -> int:
    """拉当前登录账号的收藏视频：打开自己主页收藏 tab，旁听 listcollection XHR。"""
    items = _listen_once(COLLECT_URL, COLLECT_API_RE, True,
                         max(1, min(a.limit, 30)), a.timeout, a.headed, a.profile_base)
    if not items:
        _die(f"超时（{a.timeout}s）未截到收藏数据——请确认账号下有收藏，"
             f"或稍后重试（可能被风控软拦）", 6)
    _emit(items, a.output, with_feed=False)
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
    print("✅ selftest 通过（归一化/去重/排序/时长换算/uid 提取/收藏拆包与 collect_time）")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="登录态抓取抖音博主最新作品")
    sub = ap.add_subparsers(dest="cmd")

    p = sub.add_parser("fetch", help="抓取最新作品 → JSON")
    p.add_argument("--uid", help="博主 sec_uid（MS4wLjABAAAA 开头）")
    p.add_argument("--url", help="或博主主页链接 douyin.com/user/…")
    p.add_argument("--limit", type=int, default=10)
    p.add_argument("--format", choices=["json"], default="json")
    p.add_argument("--timeout", type=int, default=90, help="总等待秒数")
    p.add_argument("--headed", action="store_true", help="有头模式（排障用）")
    p.add_argument("--profile-base", default=None, help="浏览器 profile 根目录")
    p.add_argument("-o", "--output", help="输出路径")
    p.set_defaults(func=cmd_fetch)

    c = sub.add_parser("collect", help="抓当前登录账号的收藏视频 → JSON")
    c.add_argument("--limit", type=int, default=20)
    c.add_argument("--format", choices=["json"], default="json")
    c.add_argument("--timeout", type=int, default=90, help="总等待秒数")
    c.add_argument("--headed", action="store_true", help="有头模式（排障用）")
    c.add_argument("--profile-base", default=None, help="浏览器 profile 根目录")
    c.add_argument("-o", "--output", help="输出路径")
    c.set_defaults(func=cmd_collect)

    c2 = sub.add_parser("check", help="只检查登录态")
    c2.add_argument("--profile-base", default=None)
    c2.set_defaults(func=cmd_check)

    sub.add_parser("selftest", help="离线自检").set_defaults(func=cmd_selftest)

    a = ap.parse_args()
    if not getattr(a, "func", None):
        ap.print_help()
        return 1
    return a.func(a)


if __name__ == "__main__":
    sys.exit(main())
