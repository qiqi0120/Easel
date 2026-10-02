"""自选博主热点(watchlist):存储/CRUD/保护/digest 归组、缓存与失败回落。"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "web"))

import app as web  # noqa: E402
from app import WatchlistItem  # noqa: E402

A_URL = "https://rsshub.app/bilibili/user/video/1"
B_URL = "https://example.com/b.xml"
D_UID = "MS4wLjABAAAA5FA7-I0yXFg1SjyBJCsiqy398eS_sJUhHFHQE6LVrcHzE0lLOhsSmH_OEgOwacjy"
D_URL = f"https://127.0.0.1:1200/douyin/user/{D_UID}"


@pytest.fixture()
def tmp_watchlist(tmp_path, monkeypatch):
    """watchlist 存储指到临时目录,并清空进程内缓存。"""
    f = tmp_path / "_watchlist.json"
    monkeypatch.setattr(web, "WATCHLIST_FILE", f)
    monkeypatch.setattr(web, "_WATCH_CACHE", {})
    monkeypatch.setattr(web, "WATCH_DEEP_FILE", tmp_path / "_watch_deep.json")
    return f


def _add(**kw) -> dict:
    req = WatchlistItem(**{"name": "UP主A", "feed_url": A_URL, **kw})
    return asyncio.run(web.api_watchlist_add(req))


def test_add_list_delete_roundtrip(tmp_watchlist):
    item = _add(name="A站UP主", platform="bilibili", note="数码")
    assert item["id"].startswith("wl-") and item["enabled"] is True

    with pytest.raises(web.HTTPException) as ei:      # 重复源拒绝
        _add(name="重复", feed_url=item["feed_url"])
    assert ei.value.status_code == 400

    with pytest.raises(web.HTTPException) as ei2:     # 非 http(s) 拒绝
        _add(name="坏源", feed_url="ftp://example.com/f.xml")
    assert ei2.value.status_code == 400

    items = asyncio.run(web.api_watchlist_list())
    assert [it["id"] for it in items] == [item["id"]]

    out = asyncio.run(web.api_watchlist_delete(item["id"]))
    assert out["ok"] is True
    assert asyncio.run(web.api_watchlist_list()) == []

    with pytest.raises(web.HTTPException) as ei3:     # 再删 404
        asyncio.run(web.api_watchlist_delete(item["id"]))
    assert ei3.value.status_code == 404


def test_update_toggles_enabled(tmp_watchlist):
    item = _add()
    upd = WatchlistItem(name="UP主A", feed_url=item["feed_url"], enabled=False)
    got = asyncio.run(web.api_watchlist_update(item["id"], upd))
    assert got["enabled"] is False
    stored = json.loads(tmp_watchlist.read_text(encoding="utf-8"))
    assert stored[0]["enabled"] is False

    with pytest.raises(web.HTTPException):
        asyncio.run(web.api_watchlist_update("wl-nope", upd))


def test_watchlist_file_protected_from_output_delete():
    root = web.OUTPUTS_DIR.resolve()
    assert web._is_protected(root / "_watchlist.json") is True


def test_digest_groups_disabled_and_bad_url_excluded(tmp_watchlist, monkeypatch):
    item_a = _add(name="UP主A", platform="bilibili")
    _add(name="UP主B", feed_url=B_URL)
    _add(name="停用源", feed_url="https://example.com/c.xml", enabled=False)
    # 绕过 API 校验,直接落一条坏 URL(模拟历史脏数据)
    web._write_watchlist([
        {"id": "wl-bad", "name": "坏源", "feed_url": "notaurl", "enabled": True},
        *asyncio.run(web.api_watchlist_list()),
    ])

    calls: list[str] = []

    def fake_fetch(url: str) -> list[dict]:
        calls.append(url)
        if url == A_URL:
            return [{"title": "新视频", "link": "https://b23.tv/x",
                     "summary": "内容", "_dt": "2026-10-01T09:00:00"}]
        return []   # UP主B 源本次为空

    monkeypatch.setattr(web, "_fetch_rss_source", fake_fetch)

    first = asyncio.run(web.api_watchlist_digest())
    by_name = {g["name"]: g for g in first["groups"]}
    assert set(by_name) == {"UP主A", "UP主B"}          # 停用源与坏 URL 被排除
    assert by_name["UP主A"]["items"][0]["title"] == "新视频"
    assert by_name["UP主A"]["items"][0]["url"] == "https://b23.tv/x"
    assert by_name["UP主A"]["items"][0]["date"].startswith("2026-10-01")
    assert by_name["UP主B"]["items"] == []

    # 有结果的源命中缓存;空结果不缓存,下一轮会重试
    asyncio.run(web.api_watchlist_digest())
    assert calls.count(A_URL) == 1
    assert calls.count(B_URL) == 2


def test_digest_failure_falls_back_to_cached(tmp_watchlist, monkeypatch):
    item = _add(name="UP主A")
    monkeypatch.setattr(web, "_WATCH_CACHE", {})
    # 模拟上一轮成功留下的过期缓存
    web._WATCH_CACHE[item["feed_url"]] = (
        0.0, [{"title": "旧条目", "link": "https://x/1", "summary": "", "_dt": ""}])
    monkeypatch.setattr(web, "_fetch_rss_source", lambda url: [])

    out = asyncio.run(web.api_watchlist_digest())
    assert out["groups"][0]["items"][0]["title"] == "旧条目"


def test_fetch_rss_source_swallows_process_errors(monkeypatch):
    def boom(*a, **kw):
        raise subprocess.TimeoutExpired(cmd="rss_digest", timeout=45)

    monkeypatch.setattr(web.subprocess, "run", boom)
    assert web._fetch_rss_source("https://example.com/f.xml") == []


def test_resolve_feed_url_from_profile_link_or_raw_id(monkeypatch):
    # 显式钉住实例 base,断言不随部署环境(.env 可能指向本机 RSSHub)漂移
    monkeypatch.setattr(web, "_RSSHUB_BASE", "https://rsshub.app")
    # B站:主页链接 / 裸数字 UID
    assert web._resolve_feed_url(
        "bilibili", "https://space.bilibili.com/2267573?spm_id_from=x") == \
        "https://rsshub.app/bilibili/user/video/2267573"
    assert web._resolve_feed_url("bilibili", "2267573") == \
        "https://rsshub.app/bilibili/user/video/2267573"
    # 抖音:主页链接 / 裸 sec_uid
    assert web._resolve_feed_url(
        "douyin", "https://www.douyin.com/user/MS4wLjABAAAAabcd1234567890abcd1") == \
        "https://rsshub.app/douyin/user/MS4wLjABAAAAabcd1234567890abcd1"
    assert web._resolve_feed_url("douyin", "MS4wLjABAAAAabcd1234567890abcd1") == \
        "https://rsshub.app/douyin/user/MS4wLjABAAAAabcd1234567890abcd1"
    # 小红书:主页链接 / 裸 24 位 hex,路由带 /notes
    assert web._resolve_feed_url(
        "xiaohongshu", "https://www.xiaohongshu.com/user/profile/593032945e87e77791e03696") == \
        "https://rsshub.app/xiaohongshu/user/593032945e87e77791e03696/notes"
    assert web._resolve_feed_url("xiaohongshu", "593032945e87e77791e03696") == \
        "https://rsshub.app/xiaohongshu/user/593032945e87e77791e03696/notes"


def test_resolve_feed_url_rejects_unknown_platform_and_unrecognizable_id():
    with pytest.raises(web.HTTPException) as ei:
        web._resolve_feed_url("weibo", "https://weibo.com/u/123")
    assert ei.value.status_code == 400
    with pytest.raises(web.HTTPException) as ei2:
        web._resolve_feed_url("bilibili", "张三的频道")
    assert ei2.value.status_code == 400


def test_resolve_feed_url_honors_rsshub_base_override(monkeypatch):
    monkeypatch.setattr(web, "_RSSHUB_BASE", "https://rsshub.example.internal")
    assert web._resolve_feed_url("bilibili", "2267573") == \
        "https://rsshub.example.internal/bilibili/user/video/2267573"


def test_douyin_add_stores_uid(tmp_watchlist):
    item = _add(name="抖音博主", platform="douyin", feed_url=D_URL)
    assert item["uid"] == D_UID


def test_digest_routes_douyin_to_login_fetcher(tmp_watchlist, monkeypatch):
    """抖音条目应分流到登录态抓取器,RSS 条目走 rss_digest,互不串。"""
    d_item = _add(name="抖音博主", platform="douyin", feed_url=D_URL)
    r_item = _add(name="RSS源", platform="bilibili", feed_url=B_URL)

    douyin_calls, rss_calls = [], []

    def fake_douyin(uid):
        douyin_calls.append(uid)
        return ([{"title": "新视频", "url": "https://www.douyin.com/video/x",
                  "date": "2026-10-01T20:00:00+08:00", "summary": "赞 12 · 评 3",
                  "cover": "", "feed": "", "id": "x"}],
                {"follower_count": 12300, "aweme_count": 45})

    def fake_rss(url):
        rss_calls.append(url)
        return [{"title": "新投稿", "link": "https://b23.tv/y", "summary": "",
                 "published": "2026-10-01T21:00:00"}]

    monkeypatch.setattr(web, "_fetch_douyin_source", fake_douyin)
    monkeypatch.setattr(web, "_fetch_rss_source", fake_rss)

    out = asyncio.run(web.api_watchlist_digest())
    assert douyin_calls == [d_item["uid"]] and rss_calls == [r_item["feed_url"]]
    by_name = {g["name"]: g for g in out["groups"]}
    assert by_name["抖音博主"]["items"][0]["summary"] == "赞 12 · 评 3"
    assert by_name["抖音博主"]["items"][0]["url"] == "https://www.douyin.com/video/x"
    assert by_name["抖音博主"]["stats"] == {"follower_count": 12300, "aweme_count": 45}
    assert by_name["RSS源"]["items"][0]["title"] == "新投稿"


def test_douyin_watch_script_selftest():
    """douyin_watch.py 的离线自检(归一化/去重/排序)。"""
    import subprocess as sp
    script = PROJECT_ROOT / "skills" / "shared" / "scripts" / "douyin_watch.py"
    r = sp.run([sys.executable, str(script), "selftest"], capture_output=True, text=True, timeout=60)
    assert r.returncode == 0, r.stderr


def test_digest_autonames_url_placeholder_entry(tmp_watchlist, monkeypatch):
    """名称为空/URL 充数的条目,digest 用数据源标题回填并持久化;手填名不动。"""
    _add(name="", platform="douyin", feed_url=D_URL)                  # 没填名 → 后端拿 URL 充数 → 应被回填
    _add(name="我的老朋友", platform="bilibili", feed_url=B_URL)      # 手填名 → 不动

    monkeypatch.setattr(web, "_fetch_douyin_source", lambda uid: ([
        {"title": "新视频", "url": "https://www.douyin.com/video/x",
         "date": "2026-10-01T20:00:00+08:00", "summary": "", "cover": "",
         "feed": "老头们的快乐生活", "id": "x"}], {}))
    monkeypatch.setattr(web, "_fetch_rss_source", lambda url: [])

    out = asyncio.run(web.api_watchlist_digest())
    by_id = {g["id"]: g for g in out["groups"]}
    douyin_g = next(g for g in out["groups"] if g["platform"] == "douyin")
    assert douyin_g["name"] == "老头们的快乐生活"                    # 响应里已改名
    stored = {it["name"] for it in asyncio.run(web.api_watchlist_list())}
    assert "老头们的快乐生活" in stored and "我的老朋友" in stored    # 持久化,手填名保留
    assert by_id  # 占位避免 unused


# ---- 抖音收藏（/api/watchlist/collect） ----

class _FakeProc:
    def __init__(self, returncode=0, stdout="{}", stderr=""):
        self.returncode = returncode
        self.stdout = stdout
        self.stderr = stderr


def test_fetch_douyin_collect_maps_script_output(monkeypatch):
    """脚本 JSON → digest 条目;作者/赞/评折叠进 summary。"""
    stdout = json.dumps({"count": 1, "items": [{
        "title": "收藏的视频", "url": "https://www.douyin.com/video/1",
        "created": "2026-10-01T12:00:00+08:00", "digg": 12, "comment": 3,
        "share": 0, "cover": "http://c/1.jpg", "author": "作者甲", "feed": "作者甲"}]},
        ensure_ascii=False)
    monkeypatch.setattr(web.subprocess, "run", lambda *a, **kw: _FakeProc(0, stdout))

    items, err = web._fetch_douyin_collect()
    assert err == ""
    assert items[0]["title"] == "收藏的视频"
    assert items[0]["url"] == "https://www.douyin.com/video/1"
    assert items[0]["date"] == "2026-10-01T12:00:00+08:00"
    assert items[0]["summary"] == "作者 作者甲 · 赞 12 · 评 3"
    assert items[0]["cover"] == "http://c/1.jpg"


def test_fetch_douyin_collect_reports_not_logged_in(monkeypatch):
    """脚本 exit 8（未登录）→ 空条目 + 人话提示,不抛错。"""
    monkeypatch.setattr(web.subprocess, "run", lambda *a, **kw: _FakeProc(8, "", "ERROR: 未登录"))
    items, err = web._fetch_douyin_collect()
    assert items == [] and "未登录" in err


def test_collect_endpoint_caches_and_refresh_bypasses(tmp_watchlist, monkeypatch):
    """成功结果缓存（不再起子进程）;refresh=1 绕过缓存现拉。"""
    monkeypatch.setattr(web, "_WATCH_CACHE", {})
    calls: list[int] = []

    def fake_fetch() -> tuple[list[dict], str]:
        calls.append(1)
        return [{"title": "收藏的视频", "url": "https://www.douyin.com/video/1",
                 "date": "2026-10-01T12:00:00+08:00", "summary": "赞 1", "cover": ""}], ""

    monkeypatch.setattr(web, "_fetch_douyin_collect", fake_fetch)

    first = asyncio.run(web.api_watchlist_collect())
    assert first["error"] == "" and first["items"][0]["title"] == "收藏的视频"
    cached = asyncio.run(web.api_watchlist_collect())
    assert cached["items"] == first["items"]
    assert len(calls) == 1                              # 命中缓存

    forced = asyncio.run(web.api_watchlist_collect(refresh=1))
    assert len(calls) == 2                              # refresh 强制现拉
    assert forced["items"] == first["items"]


def test_collect_endpoint_error_cached_short(tmp_watchlist, monkeypatch):
    """失败结果也缓存（避免反复起浏览器）,响应带 error 提示。

    走 tmp_watchlist 把深度缓存也指到临时目录——真实环境里未登录但深度缓存有
    历史数据时,端点按设计返回「旧条目 + error」,这里隔离后测的是纯失败路径。"""
    monkeypatch.setattr(web, "_WATCH_CACHE", {})
    calls: list[int] = []
    monkeypatch.setattr(web, "_fetch_douyin_collect",
                        lambda: calls.append(1) or ([], "抖音未登录——请先在「账号」页登录抖音，再回来刷新"))

    out = asyncio.run(web.api_watchlist_collect())
    assert out["items"] == [] and "未登录" in out["error"]
    asyncio.run(web.api_watchlist_collect())
    assert len(calls) == 1                              # 错误也命中缓存


# ---- 抖音深度加载（_watch_deep.json + 「加载更多」端点） ----

def test_deep_merge_dedupes_and_sorts():
    old = [{"id": "2", "url": "u2", "date": "2026-09-01T00:00:00+08:00"}]
    new = [{"id": "1", "url": "u1", "date": "2026-10-01T00:00:00+08:00"}, old[0]]
    merged = web._deep_merge(old, new)
    assert [it["id"] for it in merged] == ["1", "2"]     # 去重 + 新的在前
    # 无 id 的条目按 url 兜底去重
    merged2 = web._deep_merge([{"url": "u3", "date": ""}], [{"id": "9", "url": "u9", "date": "2026-01-01"}])
    assert len(merged2) == 2 and merged2[0]["id"] == "9"


def test_deep_upsert_roundtrip_and_has_more(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "WATCH_DEEP_FILE", tmp_path / "_watch_deep.json")
    entry = web._deep_upsert("collect", [{"id": "1", "url": "u1", "date": "2026-10-01", "title": "t"}])
    assert [it["id"] for it in entry["items"]] == ["1"] and entry["has_more"] is True
    # 落盘后重读（模拟服务重启），水位与条目都在
    assert [it["id"] for it in web._deep_get("collect")["items"]] == ["1"]
    web._deep_upsert("collect", has_more=False)
    assert web._deep_get("collect")["has_more"] is False


def test_douyin_deep_load_collect_merges_and_marks_done(tmp_path, monkeypatch):
    """深翻结果并入已存水位：去重、时间倒序（旧的垫底）、has_more=false 判到底。"""
    monkeypatch.setattr(web, "WATCH_DEEP_FILE", tmp_path / "_watch_deep.json")
    web._deep_write({"sources": {"collect": {
        "items": [{"id": "7300000000000000001", "title": "旧", "summary": "",
                   "url": "https://www.douyin.com/video/7300000000000000001",
                   "date": "2026-09-01T00:00:00+08:00", "cover": ""}],
        "updated": 0, "has_more": True}}})
    stdout = json.dumps({"count": 1, "has_more": False, "new_count": 1, "items": [{
        "title": "更旧的收藏", "url": "https://www.douyin.com/video/7300000000000000002",
        "created": "2026-08-01T00:00:00+08:00", "digg": 1, "comment": 0, "share": 0,
        "cover": "http://c/2.jpg", "author": "作者乙", "feed": ""}]}, ensure_ascii=False)
    captured: dict = {}

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        # seen 文件是深翻过程用的临时文件，跑完即删——趁还在先读出来
        sf = Path(cmd[cmd.index("--seen-file") + 1])
        captured["seen"] = json.loads(sf.read_text(encoding="utf-8")) if sf.exists() else None
        return _FakeProc(0, stdout)

    monkeypatch.setattr(web.subprocess, "run", fake_run)
    items, err, has_more = web._douyin_deep_load("collect", "", 15)
    assert err == "" and has_more is False
    # 按收藏时间倒序：已存的在前，深翻拿回的更旧条目垫底且不丢
    assert [it["id"] for it in items] == ["7300000000000000001", "7300000000000000002"]
    assert items[1]["summary"] == "作者 作者乙 · 赞 1 · 评 0"
    cmd = captured["cmd"]
    assert cmd[cmd.index("--want") + 1] == "15"
    assert captured["seen"] == ["7300000000000000001"]   # 已存水位作为 seen 传给脚本


def test_douyin_deep_load_new_count_zero_marks_done(tmp_path, monkeypatch):
    """滚了一圈没有新增（软到底）→ has_more 置 false，入口该消失。"""
    monkeypatch.setattr(web, "WATCH_DEEP_FILE", tmp_path / "_watch_deep.json")
    stdout = json.dumps({"count": 1, "has_more": True, "new_count": 0, "items": [
        {"title": "已看过", "url": "https://www.douyin.com/video/1", "created": "2026-09-01T00:00:00+08:00"}]},
        ensure_ascii=False)
    monkeypatch.setattr(web.subprocess, "run", lambda *a, **kw: _FakeProc(0, stdout))
    _, err, has_more = web._douyin_deep_load("collect", "", 15)
    assert err == "" and has_more is False


def test_douyin_deep_load_busy_when_locked(tmp_path, monkeypatch):
    """深翻全局串行：锁被占着 → 直接报忙，不开第二个浏览器。"""
    monkeypatch.setattr(web, "WATCH_DEEP_FILE", tmp_path / "_watch_deep.json")
    web._DEEP_RUN_LOCK.acquire()
    try:
        items, err, _ = web._douyin_deep_load("collect", "", 15)
        assert items == [] and "加载任务" in err
    finally:
        web._DEEP_RUN_LOCK.release()


def test_douyin_deep_load_error_keeps_store(tmp_path, monkeypatch):
    """未登录/风控失败 → 条目回落已存内容（不空断已拿回的数据）。"""
    monkeypatch.setattr(web, "WATCH_DEEP_FILE", tmp_path / "_watch_deep.json")
    web._deep_write({"sources": {"collect": {
        "items": [{"id": "1", "url": "u1", "date": "2026-09-01T00:00:00+08:00"}],
        "updated": 9, "has_more": True}}})
    monkeypatch.setattr(web.subprocess, "run", lambda *a, **kw: _FakeProc(8, "", "ERROR: 未登录"))
    items, err, has_more = web._douyin_deep_load("collect", "", 15)
    assert "未登录" in err and [it["id"] for it in items] == ["1"] and has_more is True


def test_blogger_deep_load_passes_uid_and_feed(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "WATCH_DEEP_FILE", tmp_path / "_watch_deep.json")
    stdout = json.dumps({"count": 1, "has_more": True, "new_count": 1, "items": [{
        "title": "作品", "url": "https://www.douyin.com/video/9",
        "created": "2026-10-01T00:00:00+08:00", "digg": 2, "comment": 1, "share": 0,
        "cover": "", "author": "博主A", "feed": "博主A"}]}, ensure_ascii=False)
    captured: dict = {}

    def fake_run(cmd, **kw):
        captured["cmd"] = cmd
        return _FakeProc(0, stdout)

    monkeypatch.setattr(web.subprocess, "run", fake_run)
    items, err, has_more = web._douyin_deep_load("blogger", "MS4wLjABAAAAxyz", 15)
    assert err == "" and has_more is True
    assert captured["cmd"][captured["cmd"].index("--uid") + 1] == "MS4wLjABAAAAxyz"
    assert items[0]["summary"] == "赞 2 · 评 1"          # 博主作品不带「作者」前缀
    assert items[0]["feed"] == "博主A"


def test_collect_load_endpoint(tmp_path, monkeypatch):
    monkeypatch.setattr(web, "WATCH_DEEP_FILE", tmp_path / "_watch_deep.json")
    monkeypatch.setattr(web, "_douyin_deep_load", lambda mode, uid="", want=15:
                        ([{"id": "1", "title": "t", "url": "u", "date": "2026-10-01",
                           "summary": "", "cover": ""}], "", False))
    out = asyncio.run(web.api_watchlist_collect_load(web.CollectLoadRequest()))
    assert out["error"] == "" and out["has_more"] is False and out["items"][0]["id"] == "1"


def test_blog_load_endpoint_guards(tmp_watchlist, monkeypatch):
    """非抖音源 400、未知 id 404、抖音源转发深翻并携带 uid。"""
    rss = _add(name="RSS源", platform="bilibili")
    with pytest.raises(web.HTTPException) as ei:
        asyncio.run(web.api_watchlist_blog_load(web.BloggerLoadRequest(id=rss["id"])))
    assert ei.value.status_code == 400
    with pytest.raises(web.HTTPException) as ei2:
        asyncio.run(web.api_watchlist_blog_load(web.BloggerLoadRequest(id="wl-nope")))
    assert ei2.value.status_code == 404

    d_item = _add(name="抖音博主", platform="douyin", feed_url=D_URL)
    called: dict = {}

    def fake_deep(mode, uid="", want=15):
        called.update(mode=mode, uid=uid)
        return ([{"id": "1", "title": "t", "url": "u", "date": "2026-10-01",
                  "summary": "", "cover": ""}], "", True)

    # 统计来自深度缓存（常规抓取时旁听落盘的），预置一条
    web._deep_write({"sources": {f"douyin:{D_UID}": {
        "items": [], "updated": 0, "has_more": True,
        "stats": {"follower_count": 5566, "aweme_count": 88}}}})
    monkeypatch.setattr(web, "_douyin_deep_load", fake_deep)
    out = asyncio.run(web.api_watchlist_blog_load(web.BloggerLoadRequest(id=d_item["id"])))
    assert called == {"mode": "blogger", "uid": D_UID}
    assert out["group"]["platform"] == "douyin" and out["has_more"] is True
    assert out["group"]["stats"] == {"follower_count": 5566, "aweme_count": 88}


def test_digest_douyin_merges_deep_store_and_not_capped(tmp_watchlist, monkeypatch):
    """抖音组 = 深度缓存 ∪ 最新一屏，且不截 15；has_more 随深度缓存。"""
    _add(name="抖音博主", platform="douyin", feed_url=D_URL)
    older = {"id": "old1", "title": "很早的作品", "url": "https://www.douyin.com/video/old1",
             "date": "2026-08-01T00:00:00+08:00", "summary": "", "cover": "", "feed": ""}
    web._deep_write({"sources": {f"douyin:{D_UID}": {"items": [older], "updated": 0, "has_more": True}}})
    fresh = [{"id": f"n{i}", "title": f"新作品{i}", "url": f"https://www.douyin.com/video/n{i}",
              "date": f"2026-10-0{i + 1}T00:00:00+08:00", "summary": "赞 1", "cover": "",
              "feed": "抖音博主"} for i in range(3)]
    monkeypatch.setattr(web, "_fetch_douyin_source", lambda uid: (fresh, {}))

    out = asyncio.run(web.api_watchlist_digest())
    g = next(g for g in out["groups"] if g["platform"] == "douyin")
    assert len(g["items"]) == 4 and g["items"][-1]["title"] == "很早的作品"
    assert g["has_more"] is True


def test_digest_douyin_stats_persist_through_failed_refetch(tmp_watchlist, monkeypatch):
    """统计落深度缓存；后续抓取拿不到统计（风控/接口没发）时保留旧值不抹掉。"""
    _add(name="抖音博主", platform="douyin", feed_url=D_URL)
    fresh = [{"id": "x1", "title": "新视频", "url": "https://www.douyin.com/video/x1",
              "date": "2026-10-01T20:00:00+08:00", "summary": "", "cover": "", "feed": ""}]
    monkeypatch.setattr(web, "_fetch_douyin_source",
                        lambda uid: (fresh, {"follower_count": 999, "aweme_count": 7}))
    out = asyncio.run(web.api_watchlist_digest())
    g = next(g for g in out["groups"] if g["platform"] == "douyin")
    assert g["stats"] == {"follower_count": 999, "aweme_count": 7}
    # 已落盘（模拟重启后仍在）
    assert web._deep_get(f"douyin:{D_UID}")["stats"] == {"follower_count": 999, "aweme_count": 7}

    # 下一轮抓取成功但没截到统计 → 旧统计保留
    monkeypatch.setattr(web, "_fetch_douyin_source", lambda uid: (fresh, {}))
    web._WATCH_CACHE.clear()
    out2 = asyncio.run(web.api_watchlist_digest())
    g2 = next(g for g in out2["groups"] if g["platform"] == "douyin")
    assert g2["stats"] == {"follower_count": 999, "aweme_count": 7}


def test_watch_deep_file_protected_from_output_delete():
    root = web.OUTPUTS_DIR.resolve()
    assert web._is_protected(root / "_watch_deep.json") is True
