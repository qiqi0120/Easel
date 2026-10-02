import { IconBookmark, IconCheck } from '../icons';

interface TrendRowProps {
  index: number;
  title: string;
  url?: string;
  /** 热搜热度值，如「128.4万」或原始数字串 */
  hot?: string;
  cover?: string;
  /** ISO 时间，展示时裁成「2026-10-01 21:40」 */
  date?: string;
  summary?: string;
  /** 合并流里标明这条来自哪个博主 */
  sourceLabel?: string;
  sourceColor?: string;
  /** 热度值靠右单行排（热搜榜单更利落）；不勾则并入来源那一行 */
  hotTrailing?: boolean;
  saved: boolean;
  onSave: () => void;
  onUse: () => void;
  /** 做内容准备中（视频源在转写语音）：按钮禁用并常显，防止重复点击 */
  busy?: boolean;
  /** 标题允许折两行（博主/收藏有正文摘要，热搜榜单行更利落） */
  clamp?: boolean;
  /** 视频条目（抖音/B站视频链接）：按钮组切成「转文字 →（已转写才出现）做内容」 */
  video?: boolean;
  /** 该视频已转写成功（转写库里有 ok 记录）——没转之前不显示「做内容」 */
  transcribed?: boolean;
  /** 这条正在转写（转文字按钮显示忙态） */
  transcribeBusy?: boolean;
  onTranscribe?: () => void;
}

const fmtDate = (d: string) => (d ? d.slice(0, 16).replace('T', ' ') : '');

// 聚合源有的给「12078425」，有的已经给「128.4万」——纯数字才折算，带单位的原样过
function fmtHot(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 10000) return v;
  return n >= 100000000 ? `${(n / 100000000).toFixed(1)}亿` : `${(n / 10000).toFixed(1)}万`;
}

/** 三种数据源共用的行：排名 / 封面 / 标题 / 来源标 + 收藏 / 做内容 / 转文字 */
export default function TrendRow(props: TrendRowProps) {
  const {
    index, title, url, hot, cover, date, summary,
    sourceLabel, sourceColor, hotTrailing, saved, onSave, onUse, busy, clamp,
    video, transcribed, transcribeBusy, onTranscribe,
  } = props;
  return (
    <div className="trend-item">
      {cover && <img className="watch-cover" src={cover} alt="" loading="lazy" referrerPolicy="no-referrer" />}
      <span className={`trend-rank${index < 3 ? ' top' : ''}`}>{index + 1}</span>
      <div className="trend-main">
        <a className={`trend-title${clamp ? ' watch-title' : ''}`} href={url || undefined} target="_blank" rel="noreferrer" title={title}>
          {title}
        </a>
        {(sourceLabel || date || (hot && !hotTrailing)) && (
          <div className="watch-meta">
            {sourceLabel && (
              <span className="trend-source">
                <i style={{ background: sourceColor || 'var(--text-tertiary)' }} />
                {sourceLabel}
              </span>
            )}
            {date && <span className="trend-hot">{fmtDate(date)}</span>}
            {hot && !hotTrailing && <span className="trend-hot">{fmtHot(hot)}</span>}
          </div>
        )}
        {summary && <div className="trend-summary">{summary}</div>}
      </div>
      {hot && hotTrailing && <span className="trend-hot trend-hot-inline">{fmtHot(hot)}</span>}
      <button
        className="trend-save"
        title={saved ? '已收藏到选题库' : '收藏到选题库'}
        onClick={onSave}
      >
        {saved ? <IconCheck size={14} /> : <IconBookmark size={14} />}
      </button>
      {/* 视频条目没转写成功前不显示「做内容」——做了内容 agent 就该拿着原文干活，
          与其点了才发现没转写（静默回落只凭标题猜），不如先引导把文字拿到手 */}
      {(!video || transcribed) && (
        <button
          className="trend-use"
          title={busy ? '正在准备内容' : '做成内容'}
          onClick={onUse}
          disabled={busy}
        >
          {busy ? '准备中…' : '做内容'}
        </button>
      )}
      {video && (
        <button
          className="trend-use"
          title={transcribeBusy ? '本地模型转写中，请稍候…'
            : transcribed ? '已转写完成——原文在内容库「视频转写」，再点一次秒回' : '把视频里的语音转成文字（本地模型，首次较慢）'}
          onClick={onTranscribe}
          disabled={transcribeBusy}
        >
          {transcribeBusy ? '转写中…' : transcribed ? '已转文字' : '转文字'}
        </button>
      )}
    </div>
  );
}
