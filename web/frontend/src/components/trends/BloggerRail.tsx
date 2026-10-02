import { avatarColor, ALL_BLOGGERS } from './mediaConfig';
import type { WatchGroup } from '../../lib/api';
import { IconPlus } from '../icons';

interface BloggerRailProps {
  groups: WatchGroup[];
  active: string;
  onChange: (id: string) => void;
  onAdd: () => void;
  /** 没订阅任何博主时，列表整体置灰并提示 */
  empty?: boolean;
}

/** 关注博主的左栏：只列当前媒体的人，默认「全部」合并时间线 */
export default function BloggerRail({ groups, active, onChange, onAdd, empty }: BloggerRailProps) {
  const total = groups.reduce((n, g) => n + g.items.length, 0);
  return (
    <aside className="blog-rail">
      <div className="blog-rail-label">该媒体的博主</div>
      <button
        className={`rail-item${active === ALL_BLOGGERS ? ' on' : ''}`}
        onClick={() => onChange(ALL_BLOGGERS)}
      >
        <span className="rail-avatar rail-avatar-all">全</span>
        <span className="rail-meta">
          <span className="rail-name">全部</span>
          <span className="rail-sub">合并时间线</span>
        </span>
        <span className="rail-count">{total}</span>
      </button>

      {groups.map((g) => (
        <button
          key={g.id}
          className={`rail-item${active === g.id ? ' on' : ''}${g.items.length === 0 ? ' stale' : ''}`}
          onClick={() => onChange(g.id)}
          title={g.items.length === 0 ? `${g.name}：最近无更新或源暂不可用` : g.name}
        >
          <span className="rail-avatar" style={{ background: avatarColor(g.id) }}>
            {g.name.slice(0, 1)}
          </span>
          <span className="rail-meta">
            <span className="rail-name">{g.name}</span>
            <span className="rail-sub">{railSub(g)}</span>
          </span>
          <span className="rail-count">{g.items.length}</span>
        </button>
      ))}

      <button className="rail-add" onClick={onAdd}>
        <IconPlus size={12} /> 添加博主
      </button>
      {empty && <p className="rail-hint">该媒体还没有订阅博主。粘贴主页链接即可，RSS 自动生成。</p>}
    </aside>
  );
}

// 自动路由的平台给个说明，手填的直说「手填 RSS」
function mediaSub(platform: string): string {
  if (platform === 'douyin' || platform === 'bilibili' || platform === 'xiaohongshu') return '自动 RSS';
  return '手填 RSS';
}

// 副标题：抓到博主统计（抖音源打开主页顺带旁听 profile 接口）就展示，否则退回来源说明
function railSub(g: WatchGroup): string {
  const { follower_count: f, aweme_count: a } = g.stats ?? {};
  if (f != null || a != null) return `粉丝 ${fmtCount(f)} · 作品 ${fmtCount(a)}`;
  return g.items.length === 0 ? '源不可用' : mediaSub(g.platform);
}

/** 大数中文缩写：12345 → 1.2万，1.2亿；空值显示 — */
function fmtCount(n?: number | null): string {
  if (n == null) return '—';
  if (n >= 1e8) return `${(n / 1e8).toFixed(1).replace(/\.0$/, '')}亿`;
  if (n >= 1e4) return `${(n / 1e4).toFixed(1).replace(/\.0$/, '')}万`;
  return String(n);
}
