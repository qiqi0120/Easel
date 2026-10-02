"""顶栏 LLM 额度：_quota_windows 的窗口识别与字段映射（纯函数，离线测）。

识别规则来自真实接口响应（open.bigmodel.cn/api/monitor/usage/quota/limit）：
limits[].unit/number 标窗口类型——3×5=5 小时窗口、6×1=周；unit 语义变化时
退回「按序取前两个」的兼容路径。
"""
from __future__ import annotations

import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(PROJECT_ROOT / "web"))

import app as web  # noqa: E402


REAL_LIMITS = [
    {"type": "CREDIT_LIMIT", "unit": 3, "number": 5, "usage": 2000,
     "currentValue": 38, "remaining": 1961, "percentage": 1, "nextResetTime": 1790972566837},
    {"type": "CREDIT_LIMIT", "unit": 6, "number": 1, "usage": 10000,
     "currentValue": 38, "remaining": 9961, "percentage": 1, "nextResetTime": 1791554321984},
]


def test_quota_windows_identifies_by_unit():
    """真实响应形状：unit 3×5 → 5 小时、6×1 → 本周，已用百分比按 usage 精算。"""
    ws = web._quota_windows(REAL_LIMITS)
    assert [w["key"] for w in ws] == ["five_hour", "weekly"]
    assert ws[0]["usedPct"] == 1.9 and ws[0]["remaining"] == 1961
    assert ws[1]["total"] == 10000 and ws[1]["resetAt"] == 1791554321984


def test_quota_windows_fallback_by_order():
    """unit 语义变了：退回按序取前两个（第一个 5 小时、第二个周）。"""
    odd = [{"type": "CREDIT_LIMIT", "unit": 9, "number": 5, "percentage": 12},
           {"type": "CREDIT_LIMIT", "unit": 9, "number": 1, "percentage": 3},
           {"type": "CREDIT_LIMIT", "unit": 9, "number": 9, "percentage": 5}]  # 第三个不取
    ws = web._quota_windows(odd)
    assert [w["key"] for w in ws] == ["five_hour", "weekly"]
    assert ws[0]["usedPct"] == 12.0 and ws[1]["usedPct"] == 3.0


def test_quota_windows_skips_non_credit():
    """TIME_LIMIT 等其他类型（如 MCP 月度次数）不进顶栏窗口。"""
    mixed = [{"type": "TIME_LIMIT", "unit": 3, "number": 5, "usage": 1000}] + REAL_LIMITS
    ws = web._quota_windows(mixed)
    assert [w["key"] for w in ws] == ["five_hour", "weekly"]
    assert web._quota_windows([]) == []
