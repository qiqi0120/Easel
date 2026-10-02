import { sourcesOf, SOURCE_LABEL } from './mediaConfig';
import type { MediaKey, SourceKey } from './mediaConfig';
import { IconFire, IconUsers, IconBookmark } from '../icons';

const ICON: Record<SourceKey, typeof IconFire> = {
  hot: IconFire,
  blog: IconUsers,
  collect: IconBookmark,
};

interface SourceTabsProps {
  media: MediaKey;
  active: SourceKey;
  onChange: (key: SourceKey) => void;
  /** 每个数据源当前的条目数（未加载为 0） */
  counts: Record<SourceKey, number>;
}

/** 二级：数据源细分。只渲染该媒体真有的源，小红书就没有「热搜榜」 */
export default function SourceTabs({ media, active, onChange, counts }: SourceTabsProps) {
  const sources = sourcesOf(media);
  return (
    <div className="source-tabs" role="tablist" aria-label="数据源">
      {sources.map((s) => {
        const Icon = ICON[s];
        return (
          <button
            key={s}
            role="tab"
            aria-selected={s === active}
            className={`source-tab${s === active ? ' on' : ''}`}
            onClick={() => onChange(s)}
          >
            <Icon size={13} />
            {SOURCE_LABEL[s]}
            <span className="source-tab-n">{counts[s]}</span>
          </button>
        );
      })}
    </div>
  );
}
