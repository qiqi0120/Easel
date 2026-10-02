#!/usr/bin/env python3
"""bili_download.py — B站视频音轨下载（转写链路用，yt-dlp 执行器）。

为什么不用 douyin_watch 那套无头浏览器旁听：B站视频页有稳定的公开 API，yt-dlp
内置 B站提取器（wbi 签名、dash 解析、格式回退都替我们做了），社区跟着B站改版
持续维护；抖音那种 a_bogus 页内签名才必须真实浏览器。本脚本只做三件确定性的事：
  1) 把 bili_login.py 产出的 biliup cookie JSON 转成 yt-dlp 认的 Netscape cookies.txt
     （TV 端扫码的 SESSDATA 对 web 播放 API 同样有效；没有 cookie 也能下大部分音频轨）；
  2) 组装并执行 yt-dlp（bestaudio 优先——转写不挑音质，还避开大会员清晰度墙）；
  3) 把标题/时长以单行 JSON 打到 stdout（web/app.py _transcribe_bili 解析）。

子命令：download / selftest

退出码（对齐 douyin_watch 的语义风格，app.py 按码给用户话术）：
  0 成功   2 视频不存在/不可见   3 需要登录或被风控   6 超时   7 下载失败

代理约束：B站是国内平台必须直连。no_proxy 只覆盖了 *.bilibili.com，而媒体流走
bilivideo.com / hdslb.com CDN——不在其中，代理变量一旦残留会把下载绕到海外出口
（慢且容易被B站判风控）。所以本进程内直接清掉代理变量（_direct_env），不依赖调用方。
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]

# bvid 固定 BV + 10 位 Base58（历史原因曾更短），放宽到 8 位以上防未来扩位误伤
BVID_RE = re.compile(r"bilibili\.com/video/(BV[0-9A-Za-z]{8,})")


def _die(msg: str, code: int) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(code)


def _direct_env() -> dict:
    """B站全链路（API + CDN）直连：清掉一切代理变量，并给 no_proxy 通配兜底。"""
    env = os.environ.copy()
    for k in ("http_proxy", "https_proxy", "all_proxy",
              "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        env.pop(k, None)
    env["no_proxy"] = "*"
    return env


def extract_bvid(url: str) -> str | None:
    """从视频页链接里取 bvid；取不到返回 None（调用方按参数错误处理）。"""
    m = BVID_RE.search(url or "")
    return m.group(1) if m else None


def biliup_cookie_to_netscape(cookie_json: dict) -> str | None:
    """biliup cookie JSON（bili_login.py 产出：cookie_info.cookies 数组）→ Netscape 文本。

    yt-dlp 只认 Netscape cookies.txt，不认 biliup 的 JSON。只转 .bilibili.com 域的
    cookie；没有 SESSDATA 等于没登录（下载意义不大），返回 None 让调用方裸奔。
    expiry 缺失按 0（session cookie）——yt-dlp 接受，有效期内使用即可。"""
    cookies = ((cookie_json.get("cookie_info") or {}).get("cookies")
               or cookie_json.get("cookies") or [])
    lines = ["# Netscape HTTP Cookie File"]
    has_sessdata = False
    for c in cookies:
        name, value = c.get("name"), c.get("value")
        if not name or value is None:
            continue
        if name == "SESSDATA":
            has_sessdata = True
        domain = c.get("domain") or ".bilibili.com"
        path = c.get("path") or "/"
        secure = "TRUE" if c.get("secure", True) else "FALSE"
        expiry = int(c.get("expires") or 0)
        lines.append(f"{domain}\tTRUE\t{path}\t{secure}\t{expiry}\t{name}\t{value}")
    return ("\n".join(lines) + "\n") if has_sessdata else None


def _load_cookie_netscape(cookie_path: Path | None) -> str | None:
    """读默认/指定 cookie 文件并转 Netscape；文件缺失或格式不对都静默返回 None
    （未登录可下载是常态，别让 cookie 问题升级成致命错误）。"""
    path = cookie_path or PROJECT_ROOT / "cookies.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return biliup_cookie_to_netscape(data)


def _classify_error(stderr: str) -> int:
    """yt-dlp 失败原因归到退出码：消息匹配是启发式——yt-dlp 没有机器可读的错误
    分类，关键词覆盖常见形态（下架/风控/登录墙），匹配不到一律按普通下载失败。"""
    s = (stderr or "").lower()
    if any(k in s for k in ("unavailable", "不存在", "已被删除", "审核中", "404",
                            "not exist", "removed")):
        return 2
    if any(k in s for k in ("login", "sign in", "登录", "412", "precondition",
                            "permission", "风控", "blocked", "captcha", "verify")):
        return 3
    return 7


def output_base(out_tmpl: str) -> str:
    """输出模板 → 去掉 %(ext)s 占位的基础名："…/audio.%(ext)s" → "…/audio"。
    尾点必须去掉：base 若是 "audio."，info/媒体的文件名会拼成 "audio..json"。"""
    base = out_tmpl.split("%(ext)s")[0] if "%(ext)s" in out_tmpl else out_tmpl
    return base.rstrip(".")


def cmd_download(a) -> int:
    bvid = extract_bvid(a.url)
    if not bvid:
        _die(f"不是B站视频链接（bilibili.com/video/BVxxx）：{a.url}", 2)

    out_tmpl = str(Path(a.output).expanduser())
    base = output_base(out_tmpl)

    cmd = [sys.executable, "-m", "yt_dlp",
           "--no-playlist",          # BV 链接理论上单视频；分P/合集链接只取本条，别拖全合集
           "--no-warnings",
           "--retries", "2",
           "-f", "bestaudio/best",   # 音轨优先；纯音频不可用时回退最优整轨（asr 能解视频）
           "--write-info-json",      # 标题/时长从这里来，不再二次请求 API
           "-o", out_tmpl,
           "--socket-timeout", "20",
           a.url]
    netscape = _load_cookie_netscape(Path(a.cookie).expanduser() if a.cookie else None)
    cookie_tmp = None
    if netscape:
        cookie_tmp = tempfile.NamedTemporaryFile(
            "w", suffix=".txt", prefix="easel-bili-cookie-", delete=False)
        cookie_tmp.write(netscape)
        cookie_tmp.close()
        cmd += ["--cookies", cookie_tmp.name]

    try:
        proc = subprocess.run(cmd, capture_output=True, env=_direct_env(), timeout=a.timeout)
    except subprocess.TimeoutExpired:
        _die(f"yt-dlp 超时（{a.timeout}s）", 6)
    finally:
        if cookie_tmp:
            try:
                os.unlink(cookie_tmp.name)
            except OSError:
                pass

    if proc.returncode != 0:
        stderr = (proc.stderr or b"").decode("utf-8", "replace")
        _die("yt-dlp 下载失败：" + "\n".join(stderr.strip().splitlines()[-5:]),
             _classify_error(stderr))

    # info json 落在 <base>.info.json；媒体在 <base>.<ext>（ext 由实际格式定）
    info_path = Path(base + ".info.json")
    try:
        info = json.loads(info_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        info = {}
    media = next((p for p in Path(base).parent.glob(Path(base).name + ".*")
                  if p.suffix.lower() not in (".json", ".part")), None)
    if not media:
        _die("yt-dlp 报成功但找不到媒体文件", 7)

    duration = info.get("duration")
    print(json.dumps({
        "bvid": bvid,
        "title": (info.get("title") or "").strip(),
        "duration_ms": int(duration * 1000) if isinstance(duration, (int, float)) and duration > 0 else None,
        "file": str(media),
    }, ensure_ascii=False))
    return 0


def cmd_selftest() -> int:
    """离线自检：cookie 转换 / bvid 解析 / yt-dlp 可用性。不碰网络下载。"""
    ok = True

    sample = {"cookie_info": {"cookies": [
        {"name": "SESSDATA", "value": "abc-123,_xyz", "domain": ".bilibili.com",
         "path": "/", "secure": True, "expires": 1800000000},
        {"name": "buvid3", "value": "u1", "domain": ".bilibili.com", "path": "/"},
    ]}}
    text = biliup_cookie_to_netscape(sample) or ""
    row = [l for l in text.splitlines() if l.startswith("#") is False and "SESSDATA" in l]
    assert row and row[0].split("\t")[6] == "abc-123,_xyz", "SESSDATA 行解析不符"
    assert "\tTRUE\t" in row[0], "Netscape 行域标志位应为 TRUE"

    assert biliup_cookie_to_netscape({"cookie_info": {"cookies": [
        {"name": "buvid3", "value": "u1"}]}}) is None, "无 SESSDATA 应返回 None（裸奔下载）"

    assert extract_bvid("https://www.bilibili.com/video/BV1GJ411x7h7/?p=1") == "BV1GJ411x7h7"
    assert extract_bvid("https://b23.tv/abc123") is None, "短链不带 bvid 应返回 None"

    try:
        v = subprocess.run([sys.executable, "-m", "yt_dlp", "--version"],
                           capture_output=True, timeout=30)
        print(f"yt-dlp: {v.stdout.decode().strip() or '不可用'}")
        ok = ok and v.returncode == 0
    except (OSError, subprocess.SubprocessError):
        print("yt-dlp: 不可用（python -m yt_dlp 失败）")
        ok = False

    print("selftest:", "OK" if ok else "FAIL")
    return 0 if ok else 1


def main() -> None:
    ap = argparse.ArgumentParser(description="B站视频音轨下载（转写链路）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("download", help="下载单条视频的音轨")
    d.add_argument("--url", required=True, help="视频页链接（bilibili.com/video/BVxxx）")
    d.add_argument("-o", "--output", required=True, help="输出模板，如 /tmp/audio.%%(ext)s")
    d.add_argument("--timeout", type=int, default=60, help="yt-dlp 总超时秒数")
    d.add_argument("--cookie", default="", help="biliup cookie JSON（默认项目根 cookies.json）")
    d.set_defaults(func=cmd_download)

    s = sub.add_parser("selftest", help="离线自检")
    s.set_defaults(func=lambda a: cmd_selftest())

    args = ap.parse_args()
    sys.exit(args.func(args))


if __name__ == "__main__":
    main()
