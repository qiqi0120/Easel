"""asr.py 双引擎分派的离线单测：参数解析、sensevoice→txt 写盘、字幕格式拒绝。

不跑真模型——_transcribe_sensevoice 打桩；whisper 真链路已有 --selftest 覆盖
（需合成语音，属外部集成，不进单测）。
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
_SCRIPT = PROJECT_ROOT / "skills" / "shared" / "scripts" / "asr.py"
_spec = importlib.util.spec_from_file_location("asr", _SCRIPT)
asr = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(asr)


def _ns(**over) -> argparse.Namespace:
    """构造 cmd_transcribe 的参数 Namespace（默认值对齐 build_parser）。"""
    base = dict(input="", output="", format="srt", model="base", language="auto",
                device="cpu", compute_type="int8", max_line_chars=18, beam_size=5)
    base.update(over)
    return argparse.Namespace(**base)


def test_parser_accepts_engine(tmp_path):
    """--engine 进解析器，且默认 whisper（老用法零感知）。"""
    ap = asr.build_parser()
    a = ap.parse_args(["transcribe", "-i", "x.mp3"])
    assert a.engine == "whisper"
    a = ap.parse_args(["transcribe", "-i", "x.mp3", "--engine", "sensevoice"])
    assert a.engine == "sensevoice"


def test_sensevoice_writes_txt(tmp_path, monkeypatch):
    """sensevoice 引擎走打桩函数：结果写进 txt，绕过 whisper 路径。"""
    called = []
    monkeypatch.setattr(asr, "_transcribe_sensevoice",
                        lambda audio, a: (called.append(str(audio)), "大家好，今天讲脆皮炸牛奶。")[1])
    src = tmp_path / "talk.mp3"
    src.write_bytes(b"fake")
    out = tmp_path / "out.txt"
    ns = _ns(input=str(src), output=str(out), format="txt", engine="sensevoice")
    rc = asr.cmd_transcribe(ns)
    assert rc == 0 and called == [str(src)]
    assert out.read_text(encoding="utf-8") == "大家好，今天讲脆皮炸牛奶。"


def test_sensevoice_rejects_subtitle_formats(tmp_path):
    """sensevoice 无词级时间戳：srt/ass 一律拒绝（退出码 2），引导换 whisper。"""
    src = tmp_path / "talk.mp3"
    src.write_bytes(b"fake")
    ns = _ns(input=str(src), output=str(tmp_path / "o.srt"), format="srt", engine="sensevoice")
    try:
        asr.cmd_transcribe(ns)
        raised = False
    except SystemExit as e:
        raised = True
        assert e.code == 2
    assert raised, "srt + sensevoice 应拒绝而非静默出无时间戳字幕"


def test_whisper_default_path_untouched(tmp_path, monkeypatch):
    """默认引擎 whisper：不碰 sensevoice 分支，仍走 _transcribe_audio（打桩验证）。"""
    called = []
    monkeypatch.setattr(asr, "_transcribe_audio",
                        lambda audio, a: (called.append(1), ([("0.0", "1.0", "内容")],
                                                            {"language": "zh", "duration_sec": 1.0,
                                                             "num_segments": 1}))[1])
    src = tmp_path / "talk.mp3"
    src.write_bytes(b"fake")
    out = tmp_path / "o.txt"
    ns = _ns(input=str(src), output=str(out), format="txt")   # 不传 engine → 默认 whisper
    assert asr.cmd_transcribe(ns) == 0
    assert called == [1] and "内容" in out.read_text(encoding="utf-8")
