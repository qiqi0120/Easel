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
}

const fmtDate = (d: string) => (d ? d.slice(0, 16).replace('T', ' ') : '');

// 聚合源有的给「12078425」，有的已经给「128.4万」——纯数字才折算，带单位的原样过
function fmtHot(v: string): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 10000) return v;
  return n >= 100000000 ? `${(n / 100000000).toFixed(1)}亿` : `${(n / 10000).toFixed(1)}万`;
}

/** 三种数据源共用的行：排名 / 封面 / 标题 / 来源标 + 收藏 / 做内容 */
export default function TrendRow(props: TrendRowProps) {
  const {
    index, title, url, hot, cover, date, summary,
    sourceLabel, sourceColor, hotTrailing, saved, onSave, onUse, busy, clamp,
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
      <button
        className="trend-use"
        title={busy ? '正在转写视频语音（首次需下载本地模型，会慢一些）' : '做成内容'}
        onClick={onUse}
        disabled={busy}
      >
        {busy ? (url ? '转写中…' : '准备中…') : '做内容'}
      </button>
    </div>
  );
}
