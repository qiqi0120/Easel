import { MEDIA, sourcesOf } from './mediaConfig';
import type { MediaKey } from './mediaConfig';

interface MediaTabsProps {
  active: MediaKey;
  onChange: (key: MediaKey) => void;
  /** 有订阅博主的媒体，打个橙点提示「这个平台你订阅了人」 */
  subscribed: Set<MediaKey>;
}

/** 一级：媒体。互斥、单一选中，切换只动这一层 */
export default function MediaTabs({ active, onChange, subscribed }: MediaTabsProps) {
  return (
    <div className="media-tabs" role="tablist" aria-label="媒体">
      {MEDIA.map((m) => (
        <button
          key={m.key}
          role="tab"
          aria-selected={m.key === active}
          className={`media-tab${m.key === active ? ' on' : ''}${m.trailing ? ' trailing' : ''}`}
          onClick={() => onChange(m.key)}
        >
          {m.label}
          <span className="media-tab-n">{sourcesOf(m.key).length}</span>
          {subscribed.has(m.key) && <span className="media-tab-dot" title="已订阅该媒体的博主" />}
        </button>
      ))}
    </div>
  );
}
