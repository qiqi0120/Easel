"""视频文字转写（做内容链路）：缓存读写/失败 TTL/并发双检回落/参数校验。

只测确定性部分（缓存与编排），下载+ASR 执行体 _transcribe_douyin 用 monkeypatch
替换，不起真浏览器、不跑 whisper。
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "web"))

import app as web  # noqa: E402
from fastapi import HTTPException  # noqa: E402

VIDEO_URL = "https://www.douyin.com/video/7300000000000000001"


@pytest.fixture()
def tmp_transcripts(tmp_path, monkeypatch):
    """转写缓存指到临时目录。"""
    monkeypatch.setattr(web, "TRANSCRIPT_DIR", tmp_path / "_transcripts")
    return tmp_path / "_transcripts"


def test_transcribe_caches_and_reuses(tmp_transcripts, monkeypatch):
    """成功结果落盘；第二次点击命中缓存，不再跑执行体。"""
    calls: list[str] = []

    def fake_run(url: str) -> dict:
        calls.append(url)
        return {"text": "这是视频里说的话", "duration": 62, "model": "faster-whisper-base"}

    monkeypatch.setattr(web, "_transcribe_douyin", fake_run)
    req = web.TranscribeRequest(url=VIDEO_URL)
    out1 = asyncio.run(web.api_transcribe(req))
    assert out1["ok"] is True and out1["cached"] is False
    assert out1["text"] == "这是视频里说的话" and out1["duration"] == 62
    assert out1["path"] == "outputs/_transcripts/7300000000000000001.json"

    out2 = asyncio.run(web.api_transcribe(req))
    assert out2["ok"] is True and out2["cached"] is True
    assert calls == [VIDEO_URL]           # 第二次没再跑执行体
    assert (tmp_transcripts / "7300000000000000001.json").is_file()


def test_transcribe_failure_cached_within_ttl(tmp_transcripts, monkeypatch):
    """失败也缓存（24h TTL 内不重试——图文/风控条目别每次点击都白跑浏览器）；过期后重试。"""
    calls: list[str] = []

    def fake_run(url: str) -> dict:
        calls.append(url)
        return {"error": "该内容是图文或无音轨，无需转写语音"}

    monkeypatch.setattr(web, "_transcribe_douyin", fake_run)
    req = web.TranscribeRequest(url=VIDEO_URL)
    out1 = asyncio.run(web.api_transcribe(req))
    assert out1["ok"] is False and "图文" in out1["error"]
    out2 = asyncio.run(web.api_transcribe(req))
    assert out2["ok"] is False and out2["cached"] is True
    assert len(calls) == 1                # TTL 内失败也算命中

    # 手动把失败记录改过期 → 下次点击重新尝试
    f = tmp_transcripts / "7300000000000000001.json"
    rec = json.loads(f.read_text(encoding="utf-8"))
    rec["updated"] -= web.TRANSCRIPT_ERROR_TTL + 1
    f.write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    out3 = asyncio.run(web.api_transcribe(req))
    assert out3["cached"] is False and len(calls) == 2


def test_transcribe_rejects_non_douyin(tmp_transcripts):
    """非抖音视频链接 400（前端 isDouyinVideoUrl 已过滤，这里是最后一道防线）。"""
    with pytest.raises(HTTPException) as ei:
        asyncio.run(web.api_transcribe(
            web.TranscribeRequest(url="https://rsshub.app/bilibili/user/video/1")))
    assert ei.value.status_code == 400


def test_transcript_cache_tolerates_corruption(tmp_transcripts):
    """损坏/缺失缓存按未命中；成功记录可写可读（原子写路径）。"""
    tmp_transcripts.mkdir(parents=True)
    (tmp_transcripts / "111.json").write_text("{不是json", encoding="utf-8")
    assert web._transcript_read("111") is None
    assert web._transcript_read("missing") is None

    web._transcript_write("222", VIDEO_URL, text="内容")
    hit = web._transcript_read("222")
    assert hit is not None and hit["text"] == "内容"

    # 空文本的成功记录不算命中（宁可重转不给空结果）
    web._transcript_write("333", VIDEO_URL, text="  ")
    assert web._transcript_read("333") is None


def test_transcribe_pipeline_shape(tmp_transcripts, monkeypatch):
    """_transcribe_douyin 的返回形状进缓存后，_transcript_response 输出完整字段。"""
    monkeypatch.setattr(web, "_transcribe_douyin",
                        lambda url: {"error": "视频下载失败——可能被风控拦截，稍后重试"})
    out = asyncio.run(web.api_transcribe(web.TranscribeRequest(url=VIDEO_URL)))
    assert set(out) == {"ok", "cached", "text", "duration", "error", "path"}
    assert out["ok"] is False and out["text"] == "" and out["duration"] is None
