"""bili_download.py 的离线单元测试：cookie 转换与 bvid 解析。

不碰网络——下载链路（yt-dlp 子进程）属外部集成，退出码映射的关键词启发式
随B站改版漂移，用 selftest 人工验证比写死断言更稳。
"""
from __future__ import annotations

import importlib.util
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
_SCRIPT = PROJECT_ROOT / "skills" / "shared" / "scripts" / "bili_download.py"
_spec = importlib.util.spec_from_file_location("bili_download", _SCRIPT)
bili = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bili)


def test_biliup_cookie_to_netscape():
    """biliup cookie JSON → Netscape 格式：SESSDATA 行字段齐全、值不被转义破坏。"""
    sample = {"cookie_info": {"cookies": [
        {"name": "SESSDATA", "value": "abc-123,_xyz", "domain": ".bilibili.com",
         "path": "/", "secure": True, "expires": 1800000000},
        {"name": "buvid3", "value": "u1", "domain": ".bilibili.com", "path": "/"},
        {"name": "bad", "value": None},          # 值缺失的脏数据：整行跳过
    ]}}
    text = bili.biliup_cookie_to_netscape(sample)
    assert text is not None and text.startswith("# Netscape HTTP Cookie File")
    rows = [l for l in text.splitlines() if not l.startswith("#")]
    sess = next(l for l in rows if "SESSDATA" in l)
    # Netscape 七段：domain \t includeSub \t path \t secure \t expiry \t name \t value
    parts = sess.split("\t")
    assert parts[0] == ".bilibili.com" and parts[1] == "TRUE" and parts[3] == "TRUE"
    assert parts[4] == "1800000000" and parts[6] == "abc-123,_xyz"
    assert len(rows) == 2                        # 脏数据行没进来


def test_cookie_without_sessdata_is_none():
    """没有 SESSDATA 等于没登录：返回 None 让调用方裸奔下载，而不是带无效 cookie。"""
    no_sess = {"cookie_info": {"cookies": [{"name": "buvid3", "value": "u1"}]}}
    assert bili.biliup_cookie_to_netscape(no_sess) is None
    assert bili.biliup_cookie_to_netscape({}) is None


def test_extract_bvid():
    """标准视频页链接取 bvid；短链/分区页不带 BV 的不给。"""
    assert bili.extract_bvid("https://www.bilibili.com/video/BV1GJ411x7h7/?p=1") == "BV1GJ411x7h7"
    assert bili.extract_bvid("https://m.bilibili.com/video/BV1abcDEFghi") == "BV1abcDEFghi"
    assert bili.extract_bvid("https://b23.tv/abc123") is None
    assert bili.extract_bvid("") is None


def test_output_base_strips_placeholder_and_dot():
    """模板切基础名：尾点必须去掉，否则拼出 "audio..info.json" 找不到文件（回归）。"""
    assert bili.output_base("/tmp/x/audio.%(ext)s") == "/tmp/x/audio"
    assert bili.output_base("/tmp/x/audio.mp4") == "/tmp/x/audio.mp4"


def test_classify_error_mapping():
    """退出码映射：不存在→2、登录/风控→3、其余→7。"""
    assert bili._classify_error("ERROR: This video is unavailable") == 2
    assert bili._classify_error("ERROR: 请先登录") == 3
    assert bili._classify_error("ERROR: HTTP Error 412") == 3
    assert bili._classify_error("ERROR: unable to download video data") == 7
