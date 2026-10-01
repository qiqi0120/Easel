import { useState, useEffect, useCallback, useRef } from 'react';
import { fetchTrends, createIdea, fetchWatchlist, addWatchlist, updateWatchlist, deleteWatchlist, fetchWatchDigest, fetchDouyinCollect, resolveRssRoute } from '../lib/api';
import type { TrendItem, TrendGroup, WatchDigestItem, WatchGroup, WatchEntry } from '../lib/api';
import { IconFire, IconRefresh, IconBookmark, IconCheck, IconEdit, IconTrash, IconPlus } from './icons';

interface TrendsPageProps {
  onUseTopic: (title: string) => void;   // 一键做成内容 → 跳 chat
}

const ALL_PLATFORMS: { key: string; label: string }[] = [
  { key: 'weibo', label: '微博' },
  { key: 'douyin', label: '抖音' },
  { key: 'zhihu', label: '知乎' },
  { key: 'bilibili', label: 'B站' },
  { key: 'baidu', label: '百度' },
  { key: 'toutiao', label: '头条' },
];

// ---- 自选博主热点（watchlist） ----
// 平台下拉：三个平台支持按博主 ID/主页链接自动生成 RSS（经 RSSHub），其他平台手填。
const WATCH_PLATFORMS = [
  { key: 'douyin', label: '抖音' },
  { key: 'bilibili', label: 'B站' },
  { key: 'xiaohongshu', label: '小红书' },
  { key: 'other', label: '其他（手填 RSS）' },
];
const watchLabel = (key: string) => WATCH_PLATFORMS.find((p) => p.key === key)?.label || key;
const pfLabel = (key: string) => ALL_PLATFORMS.find((p) => p.key === key)?.label || key;

// 「我的关注」里的特殊 tab：当前抖音账号的收藏视频（不走 watchlist 存储，登录态现拉）
const COLLECT_ID = '__collect__';

// ---- 页面级缓存：切回热点雷达直接用缓存渲染，不重新拉取 ----
// 规则：缓存超过 12 小时才自动刷新；其余一律用缓存；手动点「刷新」不受限。
// sessionStorage 存活整个标签页会话（F5 不丢、关标签页自动清空），跨页面切换靠它兜底。
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

const BLOGGER_PLACEHOLDER: Record<string, string> = {
  douyin: '如 https://www.douyin.com/user/MS4wLjABAAAA… 或直接粘贴该串',
  bilibili: '如 https://space.bilibili.com/2267573 或纯数字 UID',
  xiaohongshu: '如 https://www.xiaohongshu.com/user/profile/64… 或 24 位用户 ID',
};

// 编辑时从已存 feed_url 反解（平台, 博主 ID）；匹配不上归入"其他"
function reverseFeedUrl(url: string): { platform: string; blogger: string } {
  let m = url.match(/bilibili\/user\/video\/(\d+)/);
  if (m) return { platform: 'bilibili', blogger: m[1] };
  m = url.match(/douyin\/user\/([A-Za-z0-9_-]+)/);
  if (m) return { platform: 'douyin', blogger: m[1] };
  m = url.match(/xiaohongshu\/user\/([0-9a-f]{24})/i);
  if (m) return { platform: 'xiaohongshu', blogger: m[1] };
  return { platform: 'other', blogger: '' };
}

interface WatchForm {
  id?: string;
  name: string;
  platform: string;
  blogger: string;
  feed_url: string;
  note: string;
  enabled: boolean;
}
const EMPTY_FORM: WatchForm = { name: '', platform: 'bilibili', blogger: '', feed_url: '', note: '', enabled: true };

export default function TrendsPage({ onUseTopic }: TrendsPageProps) {
  const [saved, setSaved] = useState<Set<string>>(new Set());

  // ---- 平台热搜（tab 切换，单平台满宽） ----
  const [activePf, setActivePf] = useState('weibo');
  const [trendItems, setTrendItems] = useState<TrendItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState(0);

  // ---- 自选博主热点（watchlist，博主 tab） ----
  const [watchGroups, setWatchGroups] = useState<WatchGroup[]>([]);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchError, setWatchError] = useState('');
  const [watchUpdated, setWatchUpdated] = useState(0);
  const [activeWatch, setActiveWatch] = useState('');
  const [manageOpen, setManageOpen] = useState(false);
  const [entries, setEntries] = useState<WatchEntry[]>([]);
  const [form, setForm] = useState<WatchForm>(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [routeBusy, setRouteBusy] = useState(false);
  const resolveSeq = useRef(0);

  // ---- 抖音收藏（我的关注里的特殊 tab，首次点开才拉——起无头浏览器代价大，后端另有缓存） ----
  const [collectItems, setCollectItems] = useState<WatchDigestItem[]>([]);
  const [collectLoading, setCollectLoading] = useState(false);
  const [collectError, setCollectError] = useState('');
  const [collectUpdated, setCollectUpdated] = useState(0);
  const collectLoaded = useRef(false);

  const save = async (title: string, source: string) => {
    if (saved.has(title)) return;
    try {
      await createIdea({ title, source, status: 'pending' });
      setSaved((prev) => new Set(prev).add(title));
    } catch { /* ignore */ }
  };

  const loadTrend = useCallback((pf: string, force = false) => {
    if (!force) {   // 缓存未过期（<12h）直接渲染，不发请求
      const hit = cacheRead<{ items: TrendItem[]; updated: number }>(`trend:${pf}`);
      if (hit && !hit.stale) {
        setTrendItems(hit.data.items);
        setUpdated(hit.data.updated);
        setError('');
        return;
      }
    }
    setLoading(true);
    setError('');
    fetchTrends(pf, 30)
      .then((d) => {
        const g: TrendGroup | undefined = d.trends.find((t) => t.platform === pf);
        const items = g ? g.items : [];
        setTrendItems(items);
        setUpdated(d.updated);
        cacheWrite(`trend:${pf}`, { items, updated: d.updated });
      })
      .catch(() => setError('热点拉取失败——请确认已配置外网代理（EASEL_PROXY）。'))
      .finally(() => setLoading(false));
  }, []);

  const loadWatch = useCallback((force = false) => {
    if (!force) {
      const hit = cacheRead<{ groups: WatchGroup[]; updated: number }>('watch');
      if (hit && !hit.stale) {
        setWatchGroups(hit.data.groups);
        setWatchUpdated(hit.data.updated);
        setWatchError('');
        return;
      }
    }
    setWatchLoading(true);
    setWatchError('');
    fetchWatchDigest()
      .then((d) => {
        setWatchGroups(d.groups);
        setWatchUpdated(d.updated);
        cacheWrite('watch', d);
      })
      .catch(() => setWatchError('博主内容拉取失败——请检查订阅源地址与外网代理。'))
      .finally(() => setWatchLoading(false));
  }, []);

  const loadCollect = useCallback((refresh = false) => {
    setCollectLoading(true);
    setCollectError('');
    fetchDouyinCollect(refresh)
      .then((d) => {
        setCollectItems(d.items);
        setCollectError(d.error);   // 后端 200 + error 字段（未登录/风控），不算请求失败
        setCollectUpdated(d.updated);
        // 只缓存成功结果：失败（如未登录）不缓存，下次进来自动重试，登录后能自愈
        if (!d.error) cacheWrite('collect', d);
      })
      .catch(() => setCollectError('收藏拉取失败——请稍后重试。'))
      .finally(() => setCollectLoading(false));
  }, []);

  useEffect(() => { loadTrend(activePf); }, [loadTrend, activePf]);
  useEffect(() => { loadWatch(); }, [loadWatch]);

  const onCollectTab = activeWatch === COLLECT_ID;

  // tab 切换：收藏 tab 首次点开才拉数据（缓存未过期直接用）；博主 tab 仍由 activeWatch 记录
  const selectWatchTab = useCallback((id: string) => {
    setActiveWatch(id);
    if (id === COLLECT_ID && !collectLoaded.current) {
      collectLoaded.current = true;
      const hit = cacheRead<{ items: WatchDigestItem[]; error: string; updated: number }>('collect');
      if (hit && !hit.stale) {
        setCollectItems(hit.data.items);
        setCollectUpdated(hit.data.updated);
        return;
      }
      loadCollect();
    }
  }, [loadCollect]);

  // 博主 tab：当前选中项不在列表里（删除/首次加载）→ 回到第一个；收藏 tab 不参与
  const activeWatchGroup = watchGroups.find((g) => g.id === activeWatch) || watchGroups[0];
  useEffect(() => {
    if (onCollectTab) return;
    if (watchGroups.length && !watchGroups.some((g) => g.id === activeWatch)) {
      setActiveWatch(watchGroups[0].id);
    }
  }, [watchGroups, activeWatch, onCollectTab]);

  // ---- 管理弹窗 ----
  const openManage = async () => {
    setManageOpen(true);
    try { setEntries(await fetchWatchlist()); } catch { /* 弹窗内重试 */ }
  };

  // 平台 + 博主 → RSS 自动生成（防抖 + 竞态闩锁；仅自动平台触发）
  const isAutoPlatform = form.platform !== 'other';
  useEffect(() => {
    if (manageOpen === false) return;
    if (!isAutoPlatform) return;
    if (!form.blogger.trim()) return;
    const seq = ++resolveSeq.current;
    setRouteBusy(true);
    const t = setTimeout(() => {
      resolveRssRoute(form.platform, form.blogger)
        .then((d) => {
          if (resolveSeq.current !== seq) return;
          setForm((f) => ({ ...f, feed_url: d.feed_url }));
          setFormError('');
        })
        .catch((e) => {
          if (resolveSeq.current !== seq) return;
          setForm((f) => ({ ...f, feed_url: '' }));
          setFormError(e instanceof Error ? e.message : 'RSS 生成失败');
        })
        .finally(() => { if (resolveSeq.current === seq) setRouteBusy(false); });
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.platform, form.blogger, manageOpen]);

  const submitForm = async () => {
    setFormError('');
    if (!form.feed_url.trim()) {
      setFormError(isAutoPlatform ? '博主 ID 尚未识别出 RSS，请检查输入' : 'RSS 地址必填');
      return;
    }
    try {
      if (form.id) {
        await updateWatchlist(form.id, form);
      } else {
        await addWatchlist(form);
      }
      setForm(EMPTY_FORM);
      setEntries(await fetchWatchlist());
      loadWatch(true);   // 源列表刚变过，强制现拉并回写缓存
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '保存失败');
    }
  };
  const removeEntry = async (id: string) => {
    try {
      await deleteWatchlist(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      loadWatch(true);
    } catch { /* ignore */ }
  };
  const toggleEntry = async (e0: WatchEntry) => {
    try {
      await updateWatchlist(e0.id, { ...e0, enabled: !e0.enabled });
      setEntries((prev) => prev.map((e) => (e.id === e0.id ? { ...e, enabled: !e0.enabled } : e)));
      loadWatch(true);
    } catch { /* ignore */ }
  };
  const editEntry = (e0: WatchEntry) => {
    const rev = reverseFeedUrl(e0.feed_url);
    setForm({
      id: e0.id, name: e0.name, note: e0.note, enabled: e0.enabled,
      feed_url: e0.feed_url, platform: rev.platform, blogger: rev.blogger,
    });
    setFormError('');
  };

  const hasWatch = watchGroups.length > 0;

  return (
    <div className="page-scroll trends-page">
      <div className="page-head">
        <div>
          <h1 className="page-title"><IconFire size={22} /> 热点雷达</h1>
          <p className="page-subtitle">自选博主的最新动态和多平台热搜，挑值得做的选题，一键交给 AI。</p>
        </div>
      </div>

      {/* ============ 我的关注（置顶：抖音收藏 + 博主 tab） ============ */}
      <div className="page-head" style={{ marginTop: 4 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 18 }}>
            我的关注
            {onCollectTab ? (
              collectUpdated > 0 && <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, fontSize: 13, marginLeft: 8 }}>· {new Date(collectUpdated * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span>
            ) : (
              <>
                {hasWatch && <span className="trend-count" style={{ marginLeft: 8 }}>{watchGroups.length}</span>}
                {watchUpdated > 0 && <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, fontSize: 13, marginLeft: 8 }}>· {new Date(watchUpdated * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span>}
              </>
            )}
          </h2>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={() => (onCollectTab ? loadCollect(true) : loadWatch(true))}
            disabled={onCollectTab ? collectLoading : watchLoading}>
            <IconRefresh size={14} /> {(onCollectTab ? collectLoading : watchLoading) ? '刷新中…' : '刷新'}
          </button>
          <button className="btn btn-sm" onClick={openManage}>
            <IconEdit size={14} /> 管理
          </button>
        </div>
      </div>

      {watchError && !onCollectTab && <div className="notice-error">{watchError}</div>}

      {!hasWatch && !watchLoading && !onCollectTab && (
        <div className="card" style={{ padding: '18px 22px', color: 'var(--text-secondary)', fontSize: 14 }}>
          还没有关注的博主。点右上角「管理」添加：选平台、粘贴博主主页链接或 ID 即可，RSS 自动生成（经 RSSHub）。
        </div>
      )}

      <div className="trend-platforms">
        <button key={COLLECT_ID} className={`chip ${onCollectTab ? 'active' : ''}`}
          onClick={() => selectWatchTab(COLLECT_ID)}>
          我收藏的视频
        </button>
        {watchGroups.map((g) => (
          <button key={g.id} className={`chip ${!onCollectTab && g.id === activeWatchGroup?.id ? 'active' : ''}`}
            onClick={() => selectWatchTab(g.id)}>
            {g.name}
            {g.platform && <span style={{ opacity: 0.65, marginLeft: 5 }}>{watchLabel(g.platform)}</span>}
          </button>
        ))}
      </div>

      {onCollectTab ? (
        <>
          {collectError && <div className="notice-error">{collectError}</div>}
          <div className="card trend-col">
            <div className="trend-list" style={{ padding: '6px 0' }}>
              {collectItems.length === 0 && collectLoading &&
                <div className="trend-empty">正在拉取抖音收藏…（需要启动浏览器登录态抓取，约十几秒）</div>}
              {collectItems.length === 0 && !collectLoading && !collectError &&
                <div className="trend-empty">收藏夹暂无内容，或源暂不可用</div>}
              {collectItems.map((it, i) => (
                <div key={i} className="trend-item" style={{ padding: '10px 14px', gap: 12 }}>
                  <span className={`trend-rank ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
                  {it.cover && <img className="watch-cover" src={it.cover} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                  <div className="trend-main">
                    <a className="trend-title watch-title" href={it.url || undefined} target="_blank" rel="noreferrer"
                      title={it.title}>{it.title}</a>
                    <div className="watch-meta">
                      {it.date && <span className="trend-hot">{it.date.slice(0, 16).replace('T', ' ')}</span>}
                      {it.summary && <span className="trend-hot">{it.summary}</span>}
                    </div>
                  </div>
                  <button className="trend-save" title={saved.has(it.title) ? '已收藏到选题库' : '收藏到选题库'}
                    onClick={() => save(it.title, '抖音收藏')}>
                    {saved.has(it.title) ? <IconCheck size={14} /> : <IconBookmark size={14} />}
                  </button>
                  <button className="trend-use" title="做成内容"
                    onClick={() => onUseTopic(`抖音收藏：「${it.title}」`)}>做内容</button>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : (
        hasWatch && activeWatchGroup && (
          <div className="card trend-col">
            <div className="trend-list" style={{ padding: '6px 0' }}>
              {activeWatchGroup.items.length === 0 && !watchLoading &&
                <div className="trend-empty">最近无更新或源暂不可用</div>}
              {activeWatchGroup.items.map((it, i) => (
                <div key={i} className="trend-item" style={{ padding: '10px 14px', gap: 12 }}>
                  <span className={`trend-rank ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
                  {it.cover && <img className="watch-cover" src={it.cover} alt="" loading="lazy" referrerPolicy="no-referrer" />}
                  <div className="trend-main">
                    <a className="trend-title watch-title" href={it.url || undefined} target="_blank" rel="noreferrer"
                      title={it.title}>{it.title}</a>
                    <div className="watch-meta">
                      {it.date && <span className="trend-hot">{it.date.slice(0, 16).replace('T', ' ')}</span>}
                      {it.summary && <span className="trend-hot">{it.summary}</span>}
                    </div>
                  </div>
                  <button className="trend-save" title={saved.has(it.title) ? '已收藏到选题库' : '收藏到选题库'}
                    onClick={() => save(it.title, `博主:${activeWatchGroup.name}`)}>
                    {saved.has(it.title) ? <IconCheck size={14} /> : <IconBookmark size={14} />}
                  </button>
                  <button className="trend-use" title="做成内容"
                    onClick={() => onUseTopic(`${activeWatchGroup.name}：「${it.title}」`)}>做内容</button>
                </div>
              ))}
            </div>
          </div>
        )
      )}

      {/* ============ 平台热搜（下方，平台 tab） ============ */}
      <div className="page-head" style={{ marginTop: 26 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 18 }}>
            平台热搜
            {updated > 0 && <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, fontSize: 13, marginLeft: 8 }}>· {new Date(updated * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span>}
          </h2>
        </div>
        <button className="btn btn-sm" onClick={() => loadTrend(activePf, true)} disabled={loading}>
          <IconRefresh size={14} /> {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className="trend-platforms">
        {ALL_PLATFORMS.map((p) => (
          <button key={p.key} className={`chip ${p.key === activePf ? 'active' : ''}`}
            onClick={() => setActivePf(p.key)}>{p.label}</button>
        ))}
      </div>

      {error && <div className="notice-error">{error}</div>}

      <div className="card trend-col">
        <div className="trend-list" style={{ padding: '6px 0' }}>
          {trendItems.length === 0 && !loading && <div className="trend-empty">暂无数据</div>}
          {trendItems.map((it, i) => (
            <div key={i} className="trend-item" style={{ padding: '9px 14px', gap: 12 }}>
              <span className={`trend-rank ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
              <div className="trend-main">
                <a className="trend-title" href={it.url || undefined} target="_blank" rel="noreferrer"
                  title={it.title}>{it.title}</a>
              </div>
              {it.hot && <span className="trend-hot" style={{ flexShrink: 0 }}>{it.hot}</span>}
              <button className="trend-save" title={saved.has(it.title) ? '已收藏到选题库' : '收藏到选题库'}
                onClick={() => save(it.title, `${pfLabel(activePf)}热搜`)}>
                {saved.has(it.title) ? <IconCheck size={14} /> : <IconBookmark size={14} />}
              </button>
              <button className="trend-use" title="做成内容"
                onClick={() => onUseTopic(it.title)}>做内容</button>
            </div>
          ))}
        </div>
      </div>

      {/* ---- 管理弹窗 ---- */}
      {manageOpen && (
        <div className="overlay" onClick={() => setManageOpen(false)}>
          <div className="modal" style={{ width: 560, maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>{form.id ? '编辑博主' : '添加博主'}</h3>
              <button className="icon-btn" onClick={() => setManageOpen(false)}>×</button>
            </div>

            <label className="field-label">平台</label>
            <select className="field" value={form.platform}
              onChange={(e) => setForm({ ...form, platform: e.target.value, blogger: '', feed_url: '' })}>
              {WATCH_PLATFORMS.map((p) => (
                <option key={p.key} value={p.key}>{p.label}</option>
              ))}
            </select>

            {isAutoPlatform ? (
              <>
                <label className="field-label">博主 ID 或主页链接</label>
                <input className="field" value={form.blogger} autoFocus
                  placeholder={BLOGGER_PLACEHOLDER[form.platform] || '博主主页链接或 ID'}
                  onChange={(e) => setForm({ ...form, blogger: e.target.value })} />
                {form.platform === 'douyin' && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>
                    抖音走本机登录态抓取（需先在「账号」页登录抖音）；未登录或风控拦截时该源暂时为空。
                  </div>
                )}
                {form.feed_url && !routeBusy && (
                  <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)', wordBreak: 'break-all' }}>
                    RSS 已自动生成：{form.feed_url}
                  </div>
                )}
                {routeBusy && <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-tertiary)' }}>正在生成 RSS…</div>}
              </>
            ) : (
              <>
                <label className="field-label">RSS / Atom 地址</label>
                <input className="field" value={form.feed_url} placeholder="https://…/feed.xml"
                  onChange={(e) => setForm({ ...form, feed_url: e.target.value })} />
              </>
            )}

            <label className="field-label">名称</label>
            <input className="field" value={form.name} placeholder="博主名称（选填，默认自动取名）"
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <label className="field-label">备注</label>
            <input className="field" value={form.note} placeholder="如：数码赛道对标"
              onChange={(e) => setForm({ ...form, note: e.target.value })} />

            {formError && <div className="notice-error" style={{ marginTop: 8 }}>{formError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-sm" onClick={submitForm} disabled={routeBusy}>
                <IconPlus size={14} /> {form.id ? '保存修改' : '添加'}
              </button>
              {form.id && <button className="btn btn-sm" onClick={() => { setForm(EMPTY_FORM); setFormError(''); }}>取消编辑</button>}
            </div>

            <div style={{ marginTop: 18, maxHeight: 320, overflowY: 'auto' }}>
              {entries.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>还没有关注任何博主。</div>}
              {entries.map((e0) => (
                <div key={e0.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14 }}>
                      {e0.name}
                      <span className="trend-hot" style={{ marginLeft: 6 }}>{watchLabel(e0.platform) || '自定义'}</span>
                      {!e0.enabled && <span className="trend-hot" style={{ marginLeft: 6, opacity: 0.6 }}>已停用</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e0.feed_url}</div>
                  </div>
                  <button className="chip" onClick={() => toggleEntry(e0)}>{e0.enabled ? '停用' : '启用'}</button>
                  <button className="icon-btn" title="编辑" onClick={() => editEntry(e0)}><IconEdit size={15} /></button>
                  <button className="icon-btn" title="删除" onClick={() => removeEntry(e0.id)}><IconTrash size={15} /></button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
