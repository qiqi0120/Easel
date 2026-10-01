import { useState, useEffect, useCallback } from 'react';
import { fetchTrends, createIdea, fetchWatchlist, addWatchlist, updateWatchlist, deleteWatchlist, fetchWatchDigest } from '../lib/api';
import type { TrendGroup, WatchGroup, WatchEntry } from '../lib/api';
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

const EMPTY_FORM = { name: '', platform: '', feed_url: '', note: '', enabled: true };

export default function TrendsPage({ onUseTopic }: TrendsPageProps) {
  const [selected, setSelected] = useState<string[]>(['weibo', 'douyin', 'zhihu']);
  const [groups, setGroups] = useState<TrendGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [updated, setUpdated] = useState(0);
  const [saved, setSaved] = useState<Set<string>>(new Set());

  // ---- 自选博主热点（watchlist） ----
  const [watchGroups, setWatchGroups] = useState<WatchGroup[]>([]);
  const [watchLoading, setWatchLoading] = useState(false);
  const [watchError, setWatchError] = useState('');
  const [watchUpdated, setWatchUpdated] = useState(0);
  const [manageOpen, setManageOpen] = useState(false);
  const [entries, setEntries] = useState<WatchEntry[]>([]);
  const [form, setForm] = useState<typeof EMPTY_FORM & { id?: string }>(EMPTY_FORM);
  const [formError, setFormError] = useState('');

  const save = async (title: string, source: string) => {
    if (saved.has(title)) return;
    try {
      await createIdea({ title, source, status: 'pending' });
      setSaved((prev) => new Set(prev).add(title));
    } catch { /* ignore */ }
  };

  const load = useCallback((pfs: string[]) => {
    if (pfs.length === 0) { setGroups([]); return; }
    setLoading(true);
    setError('');
    fetchTrends(pfs.join(','), 15)
      .then((d) => { setGroups(d.trends); setUpdated(d.updated); })
      .catch(() => setError('热点拉取失败——请确认已配置外网代理（EASEL_PROXY）。'))
      .finally(() => setLoading(false));
  }, []);

  const loadWatch = useCallback(() => {
    setWatchLoading(true);
    setWatchError('');
    fetchWatchDigest()
      .then((d) => { setWatchGroups(d.groups); setWatchUpdated(d.updated); })
      .catch(() => setWatchError('博主内容拉取失败——请检查订阅源地址与外网代理。'))
      .finally(() => setWatchLoading(false));
  }, []);

  useEffect(() => { load(selected); }, [load, selected]);
  useEffect(() => { loadWatch(); }, [loadWatch]);

  const toggle = (k: string) =>
    setSelected((prev) => prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]);

  // ---- 管理弹窗 ----
  const openManage = async () => {
    setManageOpen(true);
    try { setEntries(await fetchWatchlist()); } catch { /* 弹窗内重试 */ }
  };
  const submitForm = async () => {
    setFormError('');
    if (!form.feed_url.trim()) { setFormError('RSS 地址必填'); return; }
    try {
      if (form.id) {
        await updateWatchlist(form.id, form);
      } else {
        await addWatchlist(form);
      }
      setForm(EMPTY_FORM);
      setEntries(await fetchWatchlist());
      loadWatch();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '保存失败');
    }
  };
  const removeEntry = async (id: string) => {
    try {
      await deleteWatchlist(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      loadWatch();
    } catch { /* ignore */ }
  };
  const toggleEntry = async (e0: WatchEntry) => {
    try {
      await updateWatchlist(e0.id, { ...e0, enabled: !e0.enabled });
      setEntries((prev) => prev.map((e) => (e.id === e0.id ? { ...e, enabled: !e0.enabled } : e)));
      loadWatch();
    } catch { /* ignore */ }
  };

  const hasWatch = watchGroups.length > 0;

  return (
    <div className="page-scroll trends-page">
      <div className="page-head">
        <div>
          <h1 className="page-title"><IconFire size={22} /> 热点雷达</h1>
          <p className="page-subtitle">
            多平台实时热搜，挑值得蹭的选题，一键交给 AI 做成你的内容。
            {updated > 0 && <span style={{ color: 'var(--text-tertiary)' }}> · {new Date(updated * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span>}
          </p>
        </div>
        <button className="btn btn-sm" onClick={() => load(selected)} disabled={loading}>
          <IconRefresh size={14} /> {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div className="trend-platforms">
        {ALL_PLATFORMS.map((p) => (
          <button key={p.key} className={`chip ${selected.includes(p.key) ? 'active' : ''}`}
            onClick={() => toggle(p.key)}>{p.label}</button>
        ))}
      </div>

      {error && <div className="notice-error">{error}</div>}

      <div className="trend-grid">
        {groups.map((g) => (
          <div key={g.platform} className="card trend-col">
            <div className="trend-col-head">{g.label}<span className="trend-count">{g.items.length}</span></div>
            <div className="trend-list">
              {g.items.length === 0 && !loading && <div className="trend-empty">暂无数据</div>}
              {g.items.map((it, i) => (
                <div key={i} className="trend-item">
                  <span className={`trend-rank ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
                  <div className="trend-main">
                    <a className="trend-title" href={it.url || undefined} target="_blank" rel="noreferrer"
                      title={it.title}>{it.title}</a>
                    {it.hot && <span className="trend-hot">{it.hot}</span>}
                  </div>
                  <button className="trend-save" title={saved.has(it.title) ? '已收藏到选题库' : '收藏到选题库'}
                    onClick={() => save(it.title, `${g.label}热搜`)}>
                    {saved.has(it.title) ? <IconCheck size={14} /> : <IconBookmark size={14} />}
                  </button>
                  <button className="trend-use" title="做成内容"
                    onClick={() => onUseTopic(it.title)}>做内容</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ---- 我的关注：自选博主内容 ---- */}
      <div className="page-head" style={{ marginTop: 28 }}>
        <div>
          <h2 className="page-title" style={{ fontSize: 18 }}>
            我的关注
            {hasWatch && <span className="trend-count" style={{ marginLeft: 8 }}>{watchGroups.length}</span>}
            {watchUpdated > 0 && <span style={{ color: 'var(--text-tertiary)', fontWeight: 400, fontSize: 13, marginLeft: 8 }}>· {new Date(watchUpdated * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 更新</span>}
          </h2>
          <p className="page-subtitle">自选博主的最新更新，和热搜一起进选题。</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-sm" onClick={loadWatch} disabled={watchLoading}>
            <IconRefresh size={14} /> {watchLoading ? '刷新中…' : '刷新'}
          </button>
          <button className="btn btn-sm" onClick={openManage}>
            <IconEdit size={14} /> 管理
          </button>
        </div>
      </div>

      {watchError && <div className="notice-error">{watchError}</div>}

      {!hasWatch && !watchLoading && (
        <div className="card" style={{ padding: '18px 22px', color: 'var(--text-secondary)', fontSize: 14 }}>
          还没有关注的博主。点右上角「管理」添加 RSS/Atom 订阅源——
          没有 RSS 的博主可经 RSSHub 生成，例如 B站 UP 主：<code>https://rsshub.app/bilibili/user/video/&lt;UID&gt;</code>。
        </div>
      )}

      <div className="trend-grid">
        {watchGroups.map((g) => (
          <div key={g.id} className="card trend-col">
            <div className="trend-col-head">
              {g.name}
              {g.platform && <span className="trend-hot" style={{ marginLeft: 6 }}>{g.platform}</span>}
              <span className="trend-count">{g.items.length}</span>
            </div>
            <div className="trend-list">
              {g.items.length === 0 && !watchLoading && <div className="trend-empty">最近 7 天无更新或源暂不可用</div>}
              {g.items.map((it, i) => (
                <div key={i} className="trend-item">
                  <span className={`trend-rank ${i < 3 ? 'top' : ''}`}>{i + 1}</span>
                  <div className="trend-main">
                    <a className="trend-title" href={it.url || undefined} target="_blank" rel="noreferrer"
                      title={it.title}>{it.title}</a>
                    {it.date && <span className="trend-hot">{it.date.slice(0, 16).replace('T', ' ')}</span>}
                  </div>
                  <button className="trend-save" title={saved.has(it.title) ? '已收藏到选题库' : '收藏到选题库'}
                    onClick={() => save(it.title, `博主:${g.name}`)}>
                    {saved.has(it.title) ? <IconCheck size={14} /> : <IconBookmark size={14} />}
                  </button>
                  <button className="trend-use" title="做成内容"
                    onClick={() => onUseTopic(`${g.name}：「${it.title}」`)}>做内容</button>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* ---- 管理弹窗 ---- */}
      {manageOpen && (
        <div className="overlay" onClick={() => setManageOpen(false)}>
          <div className="modal" style={{ width: 560, maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <h3 style={{ margin: 0 }}>管理我的关注</h3>
              <button className="icon-btn" onClick={() => setManageOpen(false)}>×</button>
            </div>

            <label className="field-label">{form.id ? '编辑博主' : '添加博主'}</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="field" style={{ flex: 1 }} value={form.name} placeholder="博主名称"
                onChange={(e) => setForm({ ...form, name: e.target.value })} />
              <input className="field" style={{ width: 110 }} value={form.platform} placeholder="平台"
                onChange={(e) => setForm({ ...form, platform: e.target.value })} />
            </div>
            <input className="field" style={{ marginTop: 8 }} value={form.feed_url} placeholder="RSS/Atom 地址"
              onChange={(e) => setForm({ ...form, feed_url: e.target.value })} />
            <input className="field" style={{ marginTop: 8 }} value={form.note} placeholder="备注（如：数码赛道对标）"
              onChange={(e) => setForm({ ...form, note: e.target.value })} />
            {formError && <div className="notice-error" style={{ marginTop: 8 }}>{formError}</div>}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-sm" onClick={submitForm}>
                <IconPlus size={14} /> {form.id ? '保存修改' : '添加'}
              </button>
              {form.id && <button className="btn btn-sm" onClick={() => setForm(EMPTY_FORM)}>取消编辑</button>}
            </div>

            <div style={{ marginTop: 18, maxHeight: 320, overflowY: 'auto' }}>
              {entries.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>还没有关注任何博主。</div>}
              {entries.map((e0) => (
                <div key={e0.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--border)' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14 }}>
                      {e0.name}
                      {e0.platform && <span className="trend-hot" style={{ marginLeft: 6 }}>{e0.platform}</span>}
                      {!e0.enabled && <span className="trend-hot" style={{ marginLeft: 6, opacity: 0.6 }}>已停用</span>}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e0.feed_url}</div>
                  </div>
                  <button className="chip" onClick={() => toggleEntry(e0)}>{e0.enabled ? '停用' : '启用'}</button>
                  <button className="icon-btn" title="编辑"
                    onClick={() => { setForm({ name: e0.name, platform: e0.platform, feed_url: e0.feed_url, note: e0.note, enabled: e0.enabled, id: e0.id }); }}>
                    <IconEdit size={15} />
                  </button>
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
