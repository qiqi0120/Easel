import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { fetchOutputs, fetchOutputContent, mediaUrl, deleteOutput,
         fetchTranscripts, fetchTranscript, ensureTranscript } from '../lib/api';
import type { OutputNode, OutputMeta, TranscriptItem, TranscriptState } from '../lib/api';
import { renderMarkdown } from '../lib/sanitize';
import { IconOutputs, IconImage, IconVideo, IconMusic, IconFile, IconFolder, IconRefresh, IconChevron, IconTrash } from './icons';

// 转写展示态（与后端 _transcript_state 对齐）：interrupted=占位超时（服务重启过），可重试
const T_STATE: Record<TranscriptState, { label: string; color: string }> = {
  running: { label: '转写中', color: '#d97706' },
  interrupted: { label: '已中断', color: '#dc2626' },
  error: { label: '失败', color: '#dc2626' },
  ok: { label: '已转写', color: '#16a34a' },
};

const FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'image', label: '图片' },
  { key: 'video', label: '视频' },
  { key: 'audio', label: '音频' },
  { key: 'text', label: '文档' },
];

const KIND_LABEL: Record<string, string> = {
  article: '文章', 'xhs-note': '小红书', video: '视频', cards: '卡片',
  poster: '海报', audio: '音频', other: '其他',
};
const STATUS_LABEL: Record<string, string> = { draft: '草稿', ready: '待发', published: '已发' };
const STATUS_COLOR: Record<string, string> = { draft: '#94a3b8', ready: '#d97706', published: '#16a34a' };

const badge: CSSProperties = {
  fontSize: 11, padding: '1px 7px', borderRadius: 999,
  background: 'rgba(0,0,0,0.05)', color: 'var(--text-secondary)', whiteSpace: 'nowrap',
};
const statusBadge = (s: string): CSSProperties => ({
  ...badge, background: `${STATUS_COLOR[s] || '#94a3b8'}22`, color: STATUS_COLOR[s] || '#64748b',
});

function kindIcon(kind: string | undefined, size = 30) {
  if (kind === 'video') return <IconVideo size={size} />;
  if (kind === 'audio') return <IconMusic size={size} />;
  if (kind === 'image') return <IconImage size={size} />;
  return <IconFile size={size} />;
}
const isHtml = (name: string) => /\.html?$/i.test(name);
const kindLabel = (f: OutputNode) =>
  f.kind === 'text' ? (isHtml(f.name) ? '卡片' : '文档')
    : f.kind === 'image' ? '图片' : f.kind === 'video' ? '视频' : f.kind === 'audio' ? '音频' : '文件';

/** 递归找目录下第一张图/视频作封面缩略图。 */
function firstMedia(node: OutputNode): OutputNode | null {
  if (node.type === 'file') return (node.kind === 'image' || node.kind === 'video') ? node : null;
  for (const c of node.children || []) {
    const m = firstMedia(c);
    if (m) return m;
  }
  return null;
}

/** 展示头声明的封面 → 伪 file 节点（供 Thumb 渲染）。 */
function coverNode(m?: OutputMeta): OutputNode | null {
  if (!m?.cover) return null;
  const kind = /\.(mp4|mov|webm|mkv)$/i.test(m.cover) ? 'video' : 'image';
  return { name: 'cover', type: 'file', path: m.cover, kind } as OutputNode;
}

/** 按名称路径解析到当前目录的 children（stackNames 稳定，刷新后仍有效）。 */
function resolvePath(roots: OutputNode[], names: string[]): OutputNode[] {
  let nodes = roots;
  for (const nm of names) {
    const found = nodes.find((n) => n.type === 'dir' && n.name === nm);
    if (!found) return nodes;   // 路径失效（被删/改）→ 停在能解析到的层
    nodes = found.children || [];
  }
  return nodes;
}

function Thumb({ f, big }: { f: OutputNode | null; big?: boolean }) {
  if (f && f.kind === 'image') return <img src={mediaUrl(f.path)} alt="" loading="lazy" />;
  if (f && f.kind === 'video') return <video src={mediaUrl(f.path)} preload="metadata" muted />;
  return <div className="gcard-ph">{kindIcon(f?.kind, big ? 34 : 30)}</div>;
}

interface OutputsPageProps {
  /** 从对话跳转进来的目录（outputs 相对路径，不含 outputs/ 前缀）；消费后由父层清空 */
  jumpPath?: string;
  onJumpHandled?: () => void;
  /** 「带原文去对话」：复用 App.handleUseTopic（后端按视频 id 缓存，已转的秒回） */
  onUseTopic?: (title: string, videoUrl?: string) => void | Promise<void>;
}

export default function OutputsPage({ jumpPath, onJumpHandled, onUseTopic }: OutputsPageProps) {
  const [roots, setRoots] = useState<OutputNode[]>([]);
  const [treeError, setTreeError] = useState('');
  const [stack, setStack] = useState<string[]>([]);   // 当前所在的文件夹名称路径
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<OutputNode | null>(null);
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(false);
  const reqSeq = useRef(0);

  // ---- 视频转写分区：列表 + 详情全文 + 转写中轮询 ----
  const [transcripts, setTranscripts] = useState<TranscriptItem[]>([]);
  const [selT, setSelT] = useState<TranscriptItem | null>(null);
  const [full, setFull] = useState('');
  const [fullLoading, setFullLoading] = useState(false);
  const [copyOk, setCopyOk] = useState(false);
  const [retryBusy, setRetryBusy] = useState(false);
  const tSeq = useRef(0);

  const loadTranscripts = useCallback(() => {
    // 失败静默成空列表：转写分区是锦上添花，别让它的接口问题打断内容库主视图
    fetchTranscripts().then((d) => setTranscripts(d.items)).catch(() => setTranscripts([]));
  }, []);

  const load = useCallback(() => {
    setTreeError('');
    fetchOutputs().then(setRoots).catch(() => setTreeError('加载产物列表失败'));
    loadTranscripts();
  }, [loadTranscripts]);
  useEffect(() => { load(); }, [load]);

  // 转写中条目 5s 轮询：running 占位被覆盖后，卡片自动变「已转写」
  const hasRunning = transcripts.some((t) => t.state === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const iv = setInterval(loadTranscripts, 5000);
    return () => clearInterval(iv);
  }, [hasRunning, loadTranscripts]);

  const openTranscript = useCallback((t: TranscriptItem) => {
    setSelT(t); setFull(''); setCopyOk(false);
    if (t.state !== 'ok') return;   // 未成功条目没有全文可拉（失败给错误、running 给等待）
    const seq = ++tSeq.current;
    setFullLoading(true);
    fetchTranscript(t.id)
      .then((d) => { if (tSeq.current === seq) setFull(d.text || ''); })
      .catch(() => { if (tSeq.current === seq) setFull(''); })
      .finally(() => { if (tSeq.current === seq) setFullLoading(false); });
  }, []);

  // 抽屉开着时条目状态翻转（转写完成/失败）：同步卡片态，完成则顺手拉全文
  useEffect(() => {
    if (!selT) return;
    const cur = transcripts.find((x) => x.id === selT.id);
    if (cur && cur.state !== selT.state) {
      setSelT(cur);
      if (cur.state === 'ok') openTranscript(cur);
    }
  }, [transcripts, selT, openTranscript]);

  // 对话里的目录路径跳转：展开到对应层级（路径失效时 resolvePath 自动停在能到的层）
  useEffect(() => {
    if (!jumpPath) return;
    setStack(jumpPath.split('/').filter(Boolean));
    setFilter('all');
    onJumpHandled?.();
  }, [jumpPath, onJumpHandled]);

  const currentNodes = useMemo(() => resolvePath(roots, stack), [roots, stack]);
  const dirs = useMemo(
    () => currentNodes.filter((n) => n.type === 'dir').sort((a, b) => (b.mtime || 0) - (a.mtime || 0)),
    [currentNodes]);
  const files = useMemo(() => {
    const fs = currentNodes.filter((n) => n.type === 'file').sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    return filter === 'all' ? fs : fs.filter((f) => f.kind === filter);
  }, [currentNodes, filter]);

  const atTop = stack.length === 0;
  const atProjectRoot = stack.length === 1;
  // 当前项目的展示头（进入项目后才有），用于「成品/素材」分区
  const projectMeta = useMemo(
    () => (stack.length >= 1 ? roots.find((r) => r.name === stack[0])?.meta : undefined),
    [roots, stack]);
  const deliverableSet = useMemo(
    () => new Set(atProjectRoot ? (projectMeta?.deliverablePaths || []) : []),
    [projectMeta, atProjectRoot]);
  const hasSplit = atProjectRoot && deliverableSet.size > 0;
  const deliverableFiles = useMemo(
    () => (hasSplit ? files.filter((f) => deliverableSet.has(f.path)) : []),
    [files, deliverableSet, hasSplit]);
  const restFiles = useMemo(
    () => (hasSplit ? files.filter((f) => !deliverableSet.has(f.path)) : files),
    [files, deliverableSet, hasSplit]);

  const enterDir = useCallback((name: string) => { setStack((s) => [...s, name]); setFilter('all'); }, []);
  const goTo = useCallback((depth: number) => { setStack((s) => s.slice(0, depth)); setFilter('all'); }, []);

  const remove = useCallback(async (node: OutputNode, e: React.MouseEvent) => {
    e.stopPropagation();
    const isDir = node.type === 'dir';
    const label = isDir ? `项目/文件夹「${node.meta?.title || node.name}」及其全部内容` : `文件「${node.name}」`;
    if (!window.confirm(`确定删除${label}？\n此操作不可恢复。`)) return;
    try {
      await deleteOutput(node.path);
      setSelected((cur) => (cur?.path === node.path ? null : cur));
      load();
    } catch (err) {
      alert((err as Error).message || '删除失败');
    }
  }, [load]);

  const open = useCallback(async (f: OutputNode) => {
    const seq = ++reqSeq.current;
    setSelected(f); setContent('');
    if (f.kind === 'text' && !isHtml(f.name)) {
      setLoading(true);
      try {
        const res = await fetchOutputContent(f.path);
        if (seq === reqSeq.current) setContent(res.isBinary ? '' : res.content);
      } finally { if (seq === reqSeq.current) setLoading(false); }
    }
  }, []);

  // ---- 转写分区：格式化与动作 ----
  const fmtDur = (s?: number | null) =>
    s ? (s >= 60 ? `${Math.floor(s / 60)} 分 ${Math.round(s % 60)} 秒` : `${Math.round(s)} 秒`) : '';
  // 平台时间统一东八区展示；toLocaleString 跟随系统时区，本机即 +08:00
  const fmtTime = (ts: number) =>
    ts ? new Date(ts * 1000).toLocaleString('zh-CN',
      { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '';

  const copyFull = async () => {
    try {
      await navigator.clipboard.writeText(full);
      setCopyOk(true);
      setTimeout(() => setCopyOk(false), 1500);
    } catch { /* 剪贴板被拒：静默，用户可在正文里手动选文 */ }
  };

  const downloadTxt = () => {
    if (!selT) return;
    const blob = new Blob([full], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(selT.title || selT.id).replace(/[\\/:*?"<>|]/g, '_').slice(0, 50)}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const retryTranscript = async (t: TranscriptItem, e: React.MouseEvent) => {
    e.stopPropagation();
    setRetryBusy(true);
    try { await ensureTranscript(t.url, t.title); } catch { /* 接口异常：下次再试 */ }
    finally { setRetryBusy(false); loadTranscripts(); }
  };

  const preview = () => {
    if (!selected) return null;
    const url = mediaUrl(selected.path);
    if (selected.kind === 'image') return <img src={url} alt={selected.name} style={{ maxWidth: '100%', borderRadius: 'var(--radius)' }} />;
    if (selected.kind === 'video') return <video src={url} controls style={{ maxWidth: '100%', borderRadius: 'var(--radius)' }} />;
    if (selected.kind === 'audio') return <audio src={url} controls style={{ width: '100%' }} />;
    if (selected.kind === 'text' && isHtml(selected.name)) return (
      <>
        {/* allow-scripts：让预览页自带的「复制到公众号」按钮(execCommand('copy'))能运行；
            allow="clipboard-write"：授予剪贴板写权限。不给 allow-same-origin —— iframe 保持
            opaque origin，脚本跑得起来但访问不到本站，安全。(修复：内嵌预览里复制按钮点了没反应) */}
        <iframe src={`${url}?v=${selected.mtime ?? 0}`} title={selected.name} sandbox="allow-scripts" allow="clipboard-write"
          style={{ width: '100%', height: '68vh', border: '1px solid var(--border)', borderRadius: 'var(--radius)', background: '#fff' }} />
        <div style={{ marginTop: 8 }}><a href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-start)', fontSize: 13 }}>在新标签打开 ↗</a></div>
      </>
    );
    if (selected.kind === 'text') {
      if (loading) return <div className="loading"><div className="spinner" />加载中…</div>;
      return <div className="outputs-viewer-content" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />;
    }
    return <div style={{ color: 'var(--text-secondary)', fontSize: 14 }}>无法预览。<a href={url} download style={{ color: 'var(--accent-start)' }}>下载 {selected.name}</a></div>;
  };

  /** 项目/文件夹卡片：顶层项目用展示头（标题/平台/状态/封面），嵌套子文件夹回退朴素样式。 */
  const renderDir = (d: OutputNode) => {
    const m = d.meta;
    const cover = coverNode(m) || firstMedia(d);
    return (
      <div key={d.path} className="card card-hover gcard" onClick={() => enterDir(d.name)}>
        <div className="gcard-thumb">
          <span className="gcard-kind">{m?.kind ? (KIND_LABEL[m.kind] || m.kind) : '文件夹'}</span>
          <button className="gcard-del" title="删除" onClick={(e) => remove(d, e)}><IconTrash size={14} /></button>
          {cover ? <Thumb f={cover} big /> : <div className="gcard-ph"><IconFolder size={38} /></div>}
        </div>
        <div className="gcard-meta">
          <div className="gcard-name" title={m?.title || d.name}>
            {!m && <IconFolder size={13} />} {m?.title || d.name}
          </div>
          <div className="gcard-sub" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {m?.platform && <span style={badge}>{m.platform}</span>}
            {m?.status && <span style={statusBadge(m.status)}>{STATUS_LABEL[m.status] || m.status}</span>}
            <span>{d.fileCount ?? 0} 个文件</span>
          </div>
        </div>
      </div>
    );
  };

  const renderFile = (f: OutputNode) => (
    <div key={f.path} className="card card-hover gcard" onClick={() => open(f)}>
      <div className="gcard-thumb">
        <span className="gcard-kind">{kindLabel(f)}</span>
        <button className="gcard-del" title="删除" onClick={(e) => remove(f, e)}><IconTrash size={14} /></button>
        <Thumb f={f} />
      </div>
      <div className="gcard-meta">
        <div className="gcard-name" title={f.name}>{f.name}</div>
      </div>
    </div>
  );

  /** 转写卡片：标题（无标题回退摘要/ID）+ 平台/状态徽标 + 时长与时间 */
  const renderTranscript = (t: TranscriptItem) => {
    const st = T_STATE[t.state];
    return (
      <div key={t.id} className="card card-hover gcard" onClick={() => openTranscript(t)}>
        <div className="gcard-thumb">
          <span className="gcard-kind">{t.platform === 'bilibili' ? 'B站' : '抖音'}转写</span>
          <div className="gcard-ph"><IconFile size={34} /></div>
        </div>
        <div className="gcard-meta">
          <div className="gcard-name" title={t.title || t.summary}>
            {t.title || (t.summary ? t.summary.slice(0, 26) : t.id)}
          </div>
          <div className="gcard-sub" style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ ...badge, background: `${st.color}22`, color: st.color }}>{st.label}</span>
            {t.duration ? <span>{fmtDur(t.duration)}</span> : null}
            <span>{fmtTime(t.updated)}</span>
          </div>
        </div>
      </div>
    );
  };

  const empty = dirs.length === 0 && files.length === 0;

  return (
    <div className="gallery-page">
      <div className="gallery-head">
        <div>
          <h1 className="page-title">
            <IconOutputs size={21} />
            <span className="crumb" onClick={() => goTo(0)}>内容库</span>
            {stack.map((name, i) => (
              <span key={i}>
                <span className="crumb-sep">/</span>
                {i === stack.length - 1
                  ? (projectMeta?.title && i === 0 ? projectMeta.title : name)
                  : <span className="crumb" onClick={() => goTo(i + 1)}>{name}</span>}
              </span>
            ))}
          </h1>
          <p className="page-subtitle">
            {atTop
              ? `按项目归档，共 ${roots.length} 个项目。点项目进去看成品与素材。`
              : `${dirs.length} 个文件夹 · ${files.length} 个文件（可继续点开子文件夹）`}
          </p>
        </div>
        <button className="btn btn-sm" onClick={load}><IconRefresh size={14} /> 刷新</button>
      </div>

      {treeError && <div className="notice-error">{treeError}</div>}

      {/* 项目主题标签（进入项目根时展示） */}
      {atProjectRoot && projectMeta?.tags && projectMeta.tags.length > 0 && (
        <div className="gallery-filters" style={{ marginBottom: 4 }}>
          {projectMeta.tags.map((t) => <span key={t} style={badge}>#{t}</span>)}
        </div>
      )}

      {/* 面包屑返回 + 文件过滤（进入任意层后显示） */}
      {stack.length > 0 && (
        <div className="gallery-filters">
          <button className="btn btn-sm" onClick={() => goTo(stack.length - 1)}>
            <span style={{ transform: 'rotate(180deg)', display: 'inline-flex' }}><IconChevron size={13} /></span> 返回上级
          </button>
          {files.length > 0 && FILTERS.map((f) => (
            <button key={f.key} className={`chip ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>{f.label}</button>
          ))}
        </div>
      )}

      {/* 视频转写库（只在根目录层级展示）：做内容链路转写的原文在这里回看/复制/带原文分析 */}
      {atTop && transcripts.length > 0 && (
        <>
          <div className="section-label" style={{ margin: '18px 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
            视频转写 · {transcripts.length}
          </div>
          <div className="gallery-grid">{transcripts.map(renderTranscript)}</div>
        </>
      )}

      {empty && !treeError && transcripts.length === 0 ? (
        <div className="empty-state" style={{ height: 300 }}>
          <div className="empty-icon"><IconOutputs size={44} /></div>
          <p>{atTop ? '还没有产物——去对话或技能库生成第一条内容吧' : '这个文件夹是空的'}</p>
        </div>
      ) : hasSplit ? (
        <>
          {/* 成品区 */}
          {deliverableFiles.length > 0 && (
            <>
              <div className="section-label" style={{ margin: '6px 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)' }}>
                成品 · {deliverableFiles.length}
              </div>
              <div className="gallery-grid">{deliverableFiles.map(renderFile)}</div>
            </>
          )}
          {/* 素材 / 过程文件区 */}
          {(dirs.length > 0 || restFiles.length > 0) && (
            <>
              <div className="section-label" style={{ margin: '18px 0 8px', fontSize: 13, fontWeight: 600, color: 'var(--text-tertiary)' }}>
                素材 / 过程文件
              </div>
              <div className="gallery-grid">
                {dirs.map(renderDir)}
                {restFiles.map(renderFile)}
              </div>
            </>
          )}
        </>
      ) : (
        <div className="gallery-grid">
          {dirs.map(renderDir)}
          {files.map(renderFile)}
        </div>
      )}

      {selected && (
        <div className="drawer-overlay" onClick={() => setSelected(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}>
                <div className="skill-detail-title" style={{ fontSize: 16 }}>{selected.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3, fontFamily: "'SF Mono','Consolas',monospace" }}>{selected.path}</div>
              </div>
              <button className="icon-btn" onClick={() => setSelected(null)}>×</button>
            </div>
            <div className="drawer-body">{preview()}</div>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
              <button className="btn btn-sm btn-danger" onClick={(e) => remove(selected, e)}><IconTrash size={13} /> 删除此文件</button>
            </div>
          </div>
        </div>
      )}

      {selT && (
        <div className="drawer-overlay" onClick={() => setSelT(null)}>
          <div className="drawer" onClick={(e) => e.stopPropagation()}>
            <div className="drawer-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ minWidth: 0 }}>
                <div className="skill-detail-title" style={{ fontSize: 16 }}>
                  {selT.title || (selT.summary ? selT.summary.slice(0, 30) : selT.id)}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 3 }}>
                  {selT.platform === 'bilibili' ? 'B站' : '抖音'}视频
                  {selT.duration ? ` · ${fmtDur(selT.duration)}` : ''}
                  {` · ${fmtTime(selT.updated)}`}{selT.model ? ` · ${selT.model}` : ''}
                </div>
              </div>
              <button className="icon-btn" onClick={() => setSelT(null)}>×</button>
            </div>
            <div className="drawer-body">
              {selT.state === 'running' && (
                <div className="loading"><div className="spinner" />转写中，完成后这里自动出全文……</div>
              )}
              {selT.state === 'interrupted' && (
                <div className="notice-error" style={{ marginBottom: 10 }}>转写中断（服务重启过）——点下方「重试转写」。</div>
              )}
              {selT.state === 'error' && (
                <div className="notice-error" style={{ marginBottom: 10 }}>{selT.error || '转写失败'}——可点下方「重试转写」。</div>
              )}
              {fullLoading ? (
                <div className="loading"><div className="spinner" />加载中…</div>
              ) : full ? (
                /* 转写是纯文本，保留换行直排，不走 markdown 渲染（避免特殊符号被误格式化） */
                <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.8 }}>{full}</div>
              ) : null}
              <div style={{ marginTop: 10 }}>
                <a href={selT.url} target="_blank" rel="noreferrer" style={{ color: 'var(--accent-start)', fontSize: 13 }}>查看原视频 ↗</a>
              </div>
            </div>
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
              {(selT.state === 'error' || selT.state === 'interrupted') && (
                <button className="btn btn-sm" disabled={retryBusy} onClick={(e) => retryTranscript(selT, e)}>
                  {retryBusy ? '重试中…' : '重试转写'}
                </button>
              )}
              {selT.state === 'ok' && (
                <>
                  <button className="btn btn-sm" onClick={copyFull}>{copyOk ? '已复制 ✓' : '复制全文'}</button>
                  <button className="btn btn-sm" onClick={downloadTxt}>下载 TXT</button>
                </>
              )}
              <button className="btn btn-sm" disabled={!onUseTopic}
                onClick={() => { onUseTopic?.(selT.title || (selT.summary ? selT.summary.slice(0, 40) : '这条视频'), selT.url); setSelT(null); }}>
                带原文去对话
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
