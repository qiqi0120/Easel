import { useEffect, useState } from 'react';
import { fetchLlmQuota } from '../lib/api';
import type { LlmQuota, QuotaWindow } from '../lib/api';

// 顶栏 LLM 额度条：5 小时窗口 + 本周。数据源与 ZCode/智谱控制台同一家接口，
// 由后端 /api/llm/quota 转发（60s 缓存）；前端 5 分钟轮询一次即可——窗口重置
// 是小时级事件，更勤只是浪费。非智谱 provider / 查询失败时整体隐藏，不打扰。
const POLL_MS = 5 * 60 * 1000;

function fmtReset(resetAt?: number | null, weekly?: boolean): string {
  if (!resetAt) return '';
  const ms = resetAt - Date.now();
  if (ms <= 0) return '已重置';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (weekly) {
    const d = Math.floor(ms / 86400000);
    return d >= 1 ? `${d} 天后重置` : `${h} 小时后重置`;
  }
  return h >= 1 ? `${h} 小时 ${m} 分后重置` : `${m} 分钟后重置`;
}

function Pill({ w }: { w: QuotaWindow }) {
  const pct = Math.min(100, Math.max(0, w.usedPct));
  // 三档告警色：≥90% 红、≥70% 琥珀、其余绿（阈值同社区额度监控工具的惯例）
  const color = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--amber)' : 'var(--green)';
  const pctText = pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`;
  return (
    <div className="quota-pill" title={`已用 ${w.used} / ${w.total} credits · 剩余 ${w.remaining}`}>
      <span className="quota-label">{w.label}</span>
      <div className="quota-track"><div className="quota-fill" style={{ width: `${pct}%`, background: color }} /></div>
      <span className="quota-pct" style={{ color }}>{pctText}</span>
      <span className="quota-reset">{fmtReset(w.resetAt, w.key === 'weekly')}</span>
    </div>
  );
}

export default function QuotaBar() {
  const [quota, setQuota] = useState<LlmQuota | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => {
      fetchLlmQuota()
        .then((d) => { if (alive) setQuota(d); })
        .catch(() => { /* 接口异常：保留上次数据，下个周期再试 */ });
    };
    load();
    const iv = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  // 不支持（非智谱端点）/ 查询失败 / 没有窗口数据：不渲染，顶栏保持干净
  if (!quota || !quota.supported || quota.error || !quota.windows?.length) return null;
  return (
    <div className="quota-bar">
      {quota.windows.map((w) => <Pill key={w.key} w={w} />)}
      {quota.level && <span className="quota-level">{quota.level}</span>}
    </div>
  );
}
