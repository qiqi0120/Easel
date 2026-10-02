import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchTrends, createIdea, fetchWatchDigest, fetchDouyinCollect } from '../lib/api';
import type { TrendItem, WatchDigestItem, WatchGroup } from '../lib/api';
import { IconFire, IconRefresh, IconPlus } from './icons';
import MediaTabs from './trends/MediaTabs';
import SourceTabs from './trends/SourceTabs';
import BloggerRail from './trends/BloggerRail';
import TrendRow from './trends/TrendRow';
import WatchlistDialog from './trends/WatchlistDialog';
import { ALL_BLOGGERS, DEFAULT_MEDIA, MEDIA, mediaDef, sourcesOf, avatarColor } from './trends/mediaConfig';
import type { MediaKey, SourceKey } from './trends/mediaConfig';
import type { Page } from './Sidebar';

interface TrendsPageProps {
  onUseTopic: (title: string) => void;   // 一键做成内容 → 跳 chat
  onNavigate?: (page: Page) => void;      // 收藏未登录时引导去「账号」页
}

// ---- 页面级缓存：切 tab / 切页面直接用缓存渲染，不重新拉取 ----
// 规则：缓存超过 12 小时才自动刷新；其余一律用缓存；手动点「刷新」不受限。
// sessionStorage 存活整个标签页会话（F5 不丢、关标签页自动清空），跨页面切换靠它兜底。
// 键按「媒体 + 数据源」拆，互不串味；博主分组与收藏一次拉全平台，不按媒体再切。
const STALE_MS = 12 * 60 * 60 * 1000;
const CACHE_PREFIX = 'trends-page:';

function cacheRead<T>(key: string): { data: T; stale: boolean } | null {
  try {
    const raw = sessionStorage.getItem(CACHE_PREFIX + key);
    if (!raw) return null;
    const hit = JSON.parse(raw) as { data: T; at: number };
    if (typeof hit?.at !== 'number') return null;
    return { data: hit.data, stale: Date.now() - hit.at > STALE_MS };
  } catch {
    return null;
  }
}

function cacheWrite(key: string, data: unknown): void {
  try {
    sessionStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ data, at: Date.now() }));
  } catch { /* 配额满等异常：退化为不缓存，每次现拉 */ }
}

interface HotPayload { items: TrendItem[]; updated: number }
interface BlogPayload { groups: WatchGroup[]; updated: number }
interface CollectPayload { items: WatchDigestItem[]; updated: number }

export default function TrendsPage({ onUseTopic, onNavigate }: TrendsPageProps) {
  const [saved, setSaved] = useState<Set<string>>(new Set());

  // ---- 三层导航：媒体 → 数据源 → 博主 ----
  const [media, setMedia] = useState<MediaKey>(DEFAULT_MEDIA);
  const [source, setSource] = useState<SourceKey>('hot');
  const [blogger, setBlogger] = useState<string>(ALL_BLOGGERS);
  const [dialogOpen, setDialogOpen] = useState(false);

  // ---- 热搜榜：按媒体各存一份，切回已加载的媒体不重新拉 ----
  const [hot, setHot] = useState<Partial<Record<MediaKey, HotPayload>>>({});
  const [hotLoading, setHotLoading] = useState<MediaKey | ''>('');
  const [hotError, setHotError] = useState('');
  const hotSeq = useRef(0);

  // ---- 关注博主：一次拉全平台的分组，切媒体时前端按 platform 过滤 ----
  const [groups, setGroups] = useState<WatchGroup[]>([]);
  const [blogLoading, setBlogLoading] = useState(false);
  const [blogError, setBlogError] = useState('');
  const [blogUpdated, setBlogUpdated] = useState(0);
  const blogSeq = useRef(0);

  // ---- 我的收藏：只有抖音；首次点开才拉（起无头浏览器代价大，后端另有缓存） ----
  const [collect, setCollect] = useState<CollectPayload>({ items: [], updated: 0 });
  const [collectLoading, setCollectLoading] = useState(false);
  const [collectError, setCollectError] = useState('');
  const collectLoaded = useRef(false);

  const save = async (title: string, sourceTag: string) => {
    if (saved.has(title)) return;
    try {
      await createIdea({ title, source: sourceTag, status: 'pending' });
      setSaved((prev) => new Set(prev).add(title));
    } catch { /* ignore */ }
  };

  const loadHot = useCallback((pf: MediaKey, force = false) => {
    const key = `hot:${pf}`;
    if (!force) {   // 缓存未过期（<12h）直接渲染，不发请求
      const hit = cacheRead<HotPayload>(key);
      if (hit && !hit.stale) {
        setHot((p) => ({ ...p, [pf]: hit.data }));
        setHotError('');
        return;
      }
    }
    const seq = ++hotSeq.current;
    setHotLoading(pf);
    fetchTrends(pf, 30)
      .then((d) => {
        if (hotSeq.current !== seq) return;   // 切走了就别覆盖当前视图
        const g = d.trends.find((t) => t.platform === pf);
        const items = g ? g.items : [];
        setHot((p) => ({ ...p, [pf]: { items, updated: d.updated } }));
        setHotError('');
        cacheWrite(key, { items, updated: d.updated });
      })
      .catch(() => { if (hotSeq.current === seq) setHotError('热点拉取失败——请确认已配置外网代理（EASEL_PROXY）。'); })
      .finally(() => { if (hotSeq.current === seq) setHotLoading(''); });
  }, []);

  const loadBlog = useCallback((force = false) => {
    if (!force) {
      const hit = cacheRead<BlogPayload>('blog');
      if (hit && !hit.stale) {
        setGroups(hit.data.groups);
        setBlogUpdated(hit.data.updated);
        setBlogError('');
        return;
      }
    }
    const seq = ++blogSeq.current;
    setBlogLoading(true);
    fetchWatchDigest()
      .then((d) => {
        if (blogSeq.current !== seq) return;
        setGroups(d.groups);
        setBlogUpdated(d.updated);
        setBlogError('');
        cacheWrite('blog', { groups: d.groups, updated: d.updated });
      })
      .catch(() => { if (blogSeq.current === seq) setBlogError('博主内容拉取失败——请检查订阅源地址与外网代理。'); })
      .finally(() => { if (blogSeq.current === seq) setBlogLoading(false); });
  }, []);

  const loadCollect = useCallback((refresh = false) => {
    if (!refresh) {
      const hit = cacheRead<CollectPayload>('collect');
      if (hit && !hit.stale) {
        setCollect(hit.data);
        setCollectError('');
        return;
      }
    }
    setCollectLoading(true);
    fetchDouyinCollect(refresh)
      .then((d) => {
        setCollect({ items: d.items, updated: d.updated });
        setCollectError(d.error);   // 后端 200 + error 字段（未登录/风控），不算请求失败
        // 只缓存成功结果：失败（如未登录）不缓存，下次进来自动重试，登录后能自愈
        if (!d.error) cacheWrite('collect', { items: d.items, updated: d.updated });
      })
      .catch(() => setCollectError('收藏拉取失败——请稍后重试。'))
      .finally(() => setCollectLoading(false));
  }, []);

  // 博主 digest 是一次全平台共用的请求，挂载时就拉——否则一级 tab 的「已订阅」橙点
  // 和二级的条数徽标都会先显示 0。热搜与收藏仍按需懒加载。
  useEffect(() => { loadBlog(); }, [loadBlog]);

  // 切数据源 → 懒加载当前这一个源
  useEffect(() => {
    if (source === 'hot') loadHot(media);
    else if (source === 'collect' && !collectLoaded.current) { collectLoaded.current = true; loadCollect(); }
  }, [media, source, loadHot, loadCollect]);

  const selectMedia = (key: MediaKey) => {
    setMedia(key);
    setSource(sourcesOf(key)[0]);   // 默认落到该媒体的第一个数据源
    setBlogger(ALL_BLOGGERS);
  };

  // 博主从列表里消失（删除/停用）→ 回到「全部」
  useEffect(() => {
    if (blogger === ALL_BLOGGERS) return;
    if (!groups.some((g) => g.id === blogger)) setBlogger(ALL_BLOGGERS);
  }, [groups, blogger]);

  const mediaGroups = groups.filter((g) => g.platform === media);
  const mediaItems = blogger === ALL_BLOGGERS
    ? mediaGroups.flatMap((g) => g.items.map((it) => ({ it, g })))
    : (mediaGroups.find((g) => g.id === blogger)?.items ?? []).map((it) => ({ it, g: undefined }));
  const hotPayload = hot[media];

  const counts: Record<SourceKey, number> = {
    hot: hotPayload?.items.length ?? 0,
    blog: mediaGroups.reduce((n, g) => n + g.items.length, 0),
    collect: collect.items.length,
  };

  const subscribed = mediaWithGroups(groups);

  const updated = source === 'hot' ? hotPayload?.updated ?? 0
    : source === 'blog' ? blogUpdated : collect.updated;
  const loading = source === 'hot' ? hotLoading === media
    : source === 'blog' ? blogLoading : collectLoading;
  const error = source === 'hot' ? hotError : source === 'blog' ? blogError : collectError;
  const def = mediaDef(media);

  const stamp = updated > 0
    ? `· ${new Date(updated * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新 · 缓存 12h`
    : '· 缓存 12h';

  const refresh = () => {
    if (source === 'hot') loadHot(media, true);
    else if (source === 'blog') loadBlog(true);
    else loadCollect(true);
  };

  return (
    <div className="page-scroll trends-page">
      <div className="page-head">
        <div>
          <h1 className="page-title"><IconFire size={22} /> 热点雷达</h1>
          <p className="page-subtitle">按媒体聚合各平台的热点、关注博主与收藏，挑值得做的选题，一键交给 AI。</p>
        </div>
      </div>

      {/* ===== 一级：媒体 ===== */}
      <MediaTabs active={media} onChange={selectMedia} subscribed={subscribed} />

      {/* ===== 二级：数据源 + 工具条（刷新/时间戳跟着当前 tab 走） ===== */}
      <div className="trends-toolbar">
        <SourceTabs media={media} active={source} onChange={setSource} counts={counts} />
        <div className="trends-tools">
          <span className="trends-stamp">{stamp}</span>
          <button className="btn btn-sm" onClick={refresh} disabled={loading}>
            <IconRefresh size={14} /> {loading ? '刷新中…' : '刷新'}
          </button>
          {def.blog && (
            <button className="btn btn-sm" onClick={() => setDialogOpen(true)}>
              <IconPlus size={14} /> 添加博主
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="notice-error">
          {error}
          {source === 'collect' && onNavigate && (
            <button className="btn btn-sm" style={{ marginLeft: 10 }} onClick={() => onNavigate('accounts')}>
              去账号页登录
            </button>
          )}
        </div>
      )}

      {/* ===== 三级：内容流 ===== */}
      {source === 'hot' && (
        <div className="card trend-col">
          <div className="trend-list">
            {counts.hot === 0 && loading && <div className="trend-empty">正在拉取{def.label}热搜…</div>}
            {counts.hot === 0 && !loading && !error && <div className="trend-empty">暂无数据</div>}
            {hotPayload?.items.map((it, i) => (
              <TrendRow
                key={i}
                index={i}
                title={it.title}
                url={it.url}
                hot={it.hot}
                hotTrailing
                saved={saved.has(it.title)}
                onSave={() => save(it.title, `${def.label}热搜`)}
                onUse={() => onUseTopic(it.title)}
              />
            ))}
          </div>
        </div>
      )}

      {source === 'blog' && (
        <div className="trends-blogwrap">
          <BloggerRail
            groups={mediaGroups}
            active={blogger}
            onChange={setBlogger}
            onAdd={() => setDialogOpen(true)}
            empty={mediaGroups.length === 0 && !blogLoading}
          />
          <div className="card trend-col">
            <div className="trend-list">
              {mediaItems.length === 0 && blogLoading && <div className="trend-empty">正在拉取博主内容…</div>}
              {mediaItems.length === 0 && !blogLoading && !error && (
                <div className="trend-empty">该博主最近无更新，或源暂不可用</div>
              )}
              {mediaItems.map(({ it, g }, i) => (
                <TrendRow
                  key={`${g?.id ?? 'b'}-${i}`}
                  index={i}
                  title={it.title}
                  url={it.url}
                  cover={it.cover}
                  date={it.date}
                  summary={it.summary}
                  sourceLabel={g ? g.name : undefined}
                  sourceColor={g ? avatarColor(g.id) : undefined}
                  clamp
                  saved={saved.has(it.title)}
                  onSave={() => save(it.title, `博主:${g?.name ?? def.label}`)}
                  onUse={() => onUseTopic(g ? `${g.name}：「${it.title}」` : `博主：「${it.title}」`)}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {source === 'collect' && (
        <div className="card trend-col">
          <div className="trend-list">
            {collect.items.length === 0 && collectLoading && (
              <div className="trend-empty">正在拉取抖音收藏…（需要启动浏览器登录态抓取，约十几秒）</div>
            )}
            {collect.items.length === 0 && !collectLoading && !collectError && (
              <div className="trend-empty">收藏夹暂无内容，或源暂不可用</div>
            )}
            {collect.items.map((it, i) => (
              <TrendRow
                key={i}
                index={i}
                title={it.title}
                url={it.url}
                cover={it.cover}
                date={it.date}
                summary={it.summary}
                clamp
                saved={saved.has(it.title)}
                onSave={() => save(it.title, '抖音收藏')}
                onUse={() => onUseTopic(`抖音收藏：「${it.title}」`)}
              />
            ))}
          </div>
        </div>
      )}

      {dialogOpen && (
        <WatchlistDialog
          media={media}
          onClose={() => setDialogOpen(false)}
          onChanged={() => { setBlogger(ALL_BLOGGERS); loadBlog(true); }}
        />
      )}
    </div>
  );
}

// 有订阅博主的媒体，用于一级 tab 上的橙点（忽略不认识的 platform 值）
function mediaWithGroups(groups: WatchGroup[]): Set<MediaKey> {
  const known = new Set(MEDIA.map((m) => m.key));
  const out = new Set<MediaKey>();
  for (const g of groups) {
    if (known.has(g.platform as MediaKey)) out.add(g.platform as MediaKey);
  }
  return out;
}
