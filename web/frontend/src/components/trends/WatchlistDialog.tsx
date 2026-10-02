import { useEffect, useRef, useState } from 'react';
import { fetchWatchlist, addWatchlist, updateWatchlist, deleteWatchlist, resolveRssRoute } from '../../lib/api';
import type { WatchEntry } from '../../lib/api';
import { BLOG_PLATFORMS, blogPlatformFor, mediaLabel } from './mediaConfig';
import type { MediaKey } from './mediaConfig';
import { IconEdit, IconPlus, IconTrash } from '../icons';

interface WatchlistDialogProps {
  media: MediaKey;
  onClose: () => void;
  /** 增删改后强制重拉 digest，让左栏和列表立刻反映变化 */
  onChanged: () => void;
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

const BLOGGER_PLACEHOLDER: Record<string, string> = {
  douyin: '如 https://www.douyin.com/user/MS4wLjABAAAA… 或直接粘贴该串',
  bilibili: '如 https://space.bilibili.com/2267573 或纯数字 UID',
  xiaohongshu: '如 https://www.xiaohongshu.com/user/profile/64… 或 24 位用户 ID',
};

// 编辑时从已存 feed_url 反解（平台, 博主 ID）；匹配不上归入「其他」
function reverseFeedUrl(url: string): { platform: string; blogger: string } {
  let m = url.match(/bilibili\/user\/video\/(\d+)/);
  if (m) return { platform: 'bilibili', blogger: m[1] };
  m = url.match(/douyin\/user\/([A-Za-z0-9_-]+)/);
  if (m) return { platform: 'douyin', blogger: m[1] };
  m = url.match(/xiaohongshu\/user\/profile\/([0-9a-f]{24})/i);
  if (m) return { platform: 'xiaohongshu', blogger: m[1] };
  return { platform: 'other', blogger: '' };
}

const emptyForm = (platform: string): WatchForm => ({
  name: '', platform, blogger: '', feed_url: '', note: '', enabled: true,
});

export default function WatchlistDialog({ media, onClose, onChanged }: WatchlistDialogProps) {
  const [entries, setEntries] = useState<WatchEntry[]>([]);
  const [form, setForm] = useState<WatchForm>(() => emptyForm(blogPlatformFor(media)));
  const [formError, setFormError] = useState('');
  const [routeBusy, setRouteBusy] = useState(false);
  const resolveSeq = useRef(0);

  useEffect(() => {
    fetchWatchlist().then(setEntries).catch(() => { /* 弹窗内重试 */ });
  }, []);

  const isAutoPlatform = BLOG_PLATFORMS.some((p) => p.auto && p.key === form.platform);

  // 平台 + 博主 → RSS 自动生成（防抖 400ms + 竞态闩锁；仅自动平台触发）
  useEffect(() => {
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
  }, [form.platform, form.blogger]);

  const reloadEntries = async () => {
    setEntries(await fetchWatchlist());
    onChanged();
  };

  const submit = async () => {
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
      setForm(emptyForm(blogPlatformFor(media)));
      await reloadEntries();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : '保存失败');
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteWatchlist(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      onChanged();
    } catch { /* ignore */ }
  };

  const toggle = async (e0: WatchEntry) => {
    try {
      await updateWatchlist(e0.id, { ...e0, enabled: !e0.enabled });
      setEntries((prev) => prev.map((e) => (e.id === e0.id ? { ...e, enabled: !e0.enabled } : e)));
      onChanged();
    } catch { /* ignore */ }
  };

  const edit = (e0: WatchEntry) => {
    const rev = reverseFeedUrl(e0.feed_url);
    setForm({
      id: e0.id, name: e0.name, note: e0.note, enabled: e0.enabled,
      feed_url: e0.feed_url, platform: rev.platform, blogger: rev.blogger,
    });
    setFormError('');
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" style={{ width: 560, maxWidth: '100%' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
          <h3 style={{ margin: 0 }}>{form.id ? '编辑博主' : `添加博主 · ${mediaLabel(blogPlatformFor(media))}`}</h3>
          <button className="icon-btn" onClick={onClose}>×</button>
        </div>

        <label className="field-label">平台</label>
        <select
          className="field"
          value={form.platform}
          onChange={(e) => setForm({ ...form, platform: e.target.value, blogger: '', feed_url: '' })}
        >
          {BLOG_PLATFORMS.map((p) => (
            <option key={p.key} value={p.key}>{p.label}</option>
          ))}
        </select>

        {isAutoPlatform ? (
          <>
            <label className="field-label">博主 ID 或主页链接</label>
            <input
              className="field"
              value={form.blogger}
              autoFocus
              placeholder={BLOGGER_PLACEHOLDER[form.platform] || '博主主页链接或 ID'}
              onChange={(e) => setForm({ ...form, blogger: e.target.value })}
            />
            {form.platform === 'douyin' && (
              <div className="field-hint">抖音走本机登录态抓取（需先在「账号」页登录抖音）；未登录或风控拦截时该源暂时为空。</div>
            )}
            {form.feed_url && !routeBusy && (
              <div className="field-hint break">RSS 已自动生成：{form.feed_url}</div>
            )}
            {routeBusy && <div className="field-hint">正在生成 RSS…</div>}
          </>
        ) : (
          <>
            <label className="field-label">RSS / Atom 地址</label>
            <input
              className="field"
              value={form.feed_url}
              placeholder="https://…/feed.xml"
              onChange={(e) => setForm({ ...form, feed_url: e.target.value })}
            />
          </>
        )}

        <label className="field-label">名称</label>
        <input
          className="field"
          value={form.name}
          placeholder="博主名称（选填，默认自动取名）"
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
        <label className="field-label">备注</label>
        <input
          className="field"
          value={form.note}
          placeholder="如：数码赛道对标"
          onChange={(e) => setForm({ ...form, note: e.target.value })}
        />

        {formError && <div className="notice-error" style={{ marginTop: 8 }}>{formError}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <button className="btn btn-sm" onClick={submit} disabled={routeBusy}>
            <IconPlus size={14} /> {form.id ? '保存修改' : '添加'}
          </button>
          {form.id && (
            <button className="btn btn-sm" onClick={() => { setForm(emptyForm(blogPlatformFor(media))); setFormError(''); }}>
              取消编辑
            </button>
          )}
        </div>

        <div style={{ marginTop: 18, maxHeight: 320, overflowY: 'auto' }}>
          {entries.length === 0 && <div style={{ color: 'var(--text-secondary)', fontSize: 13 }}>还没有关注任何博主。</div>}
          {entries.map((e0) => (
            <div key={e0.id} className="watch-entry">
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14 }}>
                  {e0.name}
                  <span className="trend-hot" style={{ marginLeft: 6 }}>{mediaLabel(e0.platform) || '自定义'}</span>
                  {!e0.enabled && <span className="trend-hot" style={{ marginLeft: 6, opacity: 0.6 }}>已停用</span>}
                </div>
                <div className="watch-entry-url">{e0.feed_url}</div>
              </div>
              <button className="chip" onClick={() => toggle(e0)}>{e0.enabled ? '停用' : '启用'}</button>
              <button className="icon-btn" title="编辑" onClick={() => edit(e0)}><IconEdit size={15} /></button>
              <button className="icon-btn" title="删除" onClick={() => remove(e0.id)}><IconTrash size={15} /></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
