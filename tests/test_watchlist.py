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


@pytest.fixture()
def tmp_watchlist(tmp_path, monkeypatch):
    """watchlist 存储指到临时目录,并清空进程内缓存。"""
    f = tmp_path / "_watchlist.json"
    monkeypatch.setattr(web, "WATCHLIST_FILE", f)
    monkeypatch.setattr(web, "_WATCH_CACHE", {})
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
