import { useState } from 'react';
import type { ChatSession } from '../lib/store';
import type { PersonaItem } from '../lib/api';
import type { ComponentType } from 'react';
import {
  IconChat, IconSkills, IconOutputs, IconAccounts, IconProfile,
  IconNewChat, IconEdit, IconArchive, IconUnarchive, IconTrash, IconChevron,
  IconDashboard,
} from './icons';
import { IconGear } from './settingsIcons';

const HINT_KEY = 'easel_persona_hint_seen';

export type Page = 'dashboard' | 'chat' | 'trends' | 'ideas' | 'calendar' | 'publish' | 'breakdown' | 'skills' | 'outputs' | 'accounts' | 'profile';

interface SidebarProps {
  currentPage: Page;
  onPageChange: (page: Page) => void;
  personas: PersonaItem[];
  selectedPersona: string;
  onPersonaChange: (persona: string) => void;
  onNewProfile: () => void;
  sessions: ChatSession[];
  activeSessionId: string | null;
  activeSessionHasMessages: boolean;
  onSessionSelect: (id: string) => void;
  onSessionDelete: (id: string) => void;
  onSessionRename: (id: string, title: string) => void;
  onSessionArchive: (id: string, archived: boolean) => void;
  onNewChat: () => void;
  gatewayStatus: string;
  onOpenSettings: () => void;
}

// 主导航（精简）；热点雷达/选题库/内容日历/发布中心 收进「工作台」，不占侧栏
const NAV: { page: Page; Icon: ComponentType<{ size?: number }>; label: string }[] = [
  { page: 'dashboard', Icon: IconDashboard, label: '工作台' },
  { page: 'chat', Icon: IconChat, label: '对话' },
  { page: 'skills', Icon: IconSkills, label: '技能库' },
  { page: 'outputs', Icon: IconOutputs, label: '内容库' },
  { page: 'accounts', Icon: IconAccounts, label: '账号' },
  { page: 'profile', Icon: IconProfile, label: '画像' },
];

// 画像头像圆点：底色按画像名哈希从 6 色色板（--persona-c1..c6，见 index.css）轮转，
// 同名画像永远同色；size < 12px 时首字不可读，只渲染色点。
const PERSONA_PALETTE_SIZE = 6;

function personaColorIndex(name: string): number {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + (ch.codePointAt(0) ?? 0)) >>> 0;
  return hash % PERSONA_PALETTE_SIZE;
}

function PersonaAvatar({ name, size = 18 }: { name: string; size?: number }) {
  if (!name) {
    return <span className="persona-avatar generic" style={{ width: size, height: size }} />;
  }
  return (
    <span
      className="persona-avatar"
      style={{
        width: size,
        height: size,
        background: `var(--persona-c${personaColorIndex(name) + 1})`,
        fontSize: Math.round(size * 0.56),
      }}
    >
      {size >= 12 ? Array.from(name)[0] : null}
    </span>
  );
}

export default function Sidebar({
  currentPage,
  onPageChange,
  personas,
  selectedPersona,
  onPersonaChange,
  onNewProfile,
  sessions,
  activeSessionId,
  activeSessionHasMessages,
  onSessionSelect,
  onSessionDelete,
  onSessionRename,
  onSessionArchive,
  onNewChat,
  gatewayStatus,
  onOpenSettings,
}: SidebarProps) {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  // 首次引导：未交互过且已有画像时，给下拉框加光晕＋提示语；首次点击即写入标记永久消失。
  // localStorage 读失败（隐私模式等）→ 永不提示；写失败 → 本次已隐藏，最多下次会话再提示一次。
  const [showHint, setShowHint] = useState(() => {
    try { return !localStorage.getItem(HINT_KEY); } catch { return false; }
  });
  const dismissHint = () => {
    if (!showHint) return;
    try { localStorage.setItem(HINT_KEY, '1'); } catch { /* 写失败可接受 */ }
    setShowHint(false);
  };

  const startRename = (s: ChatSession) => { setRenamingId(s.id); setRenameValue(s.title); };
  const commitRename = () => {
    if (renamingId) onSessionRename(renamingId, renameValue);
    setRenamingId(null);
  };

  const active = sessions.filter((s) => !s.archived && (s.messages.length > 0 || s.id === activeSessionId));
  const archived = sessions.filter((s) => s.archived);

  const renderItem = (s: ChatSession, isArchived: boolean) => {
    if (renamingId === s.id) {
      return (
        <div key={s.id} className="session-item">
          <input
            className="session-rename-input"
            value={renameValue}
            autoFocus
            onChange={(e) => setRenameValue(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              else if (e.key === 'Escape') setRenamingId(null);
            }}
            onBlur={commitRename}
          />
        </div>
      );
    }
    return (
      <div
        key={s.id}
        className={`session-item ${s.id === activeSessionId ? 'active' : ''}`}
        onClick={() => onSessionSelect(s.id)}
      >
        <span className="session-item-title">{s.title}</span>
        {s.persona && (
          <span className="session-persona-dot" title={`画像：${s.persona}`}>
            <PersonaAvatar name={s.persona} size={9} />
          </span>
        )}
        <div className="session-actions">
          <button className="session-act" title="重命名"
            onClick={(e) => { e.stopPropagation(); startRename(s); }}><IconEdit size={14} /></button>
          <button className="session-act" title={isArchived ? '取消归档' : '归档'}
            onClick={(e) => { e.stopPropagation(); onSessionArchive(s.id, !isArchived); }}>
            {isArchived ? <IconUnarchive size={14} /> : <IconArchive size={14} />}
          </button>
          <button className="session-act danger" title="删除"
            onClick={(e) => { e.stopPropagation(); onSessionDelete(s.id); }}><IconTrash size={14} /></button>
        </div>
      </div>
    );
  };

  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">
          <img className="sidebar-logo-icon" src="./static/easel-icon-transparent.png" alt="" />
          <h1>Atelier</h1>
        </div>
        <div
          className={`persona-field ${showHint && personas.length > 0 ? 'hint' : ''}`}
          onMouseDown={dismissHint}
        >
          <span className="persona-field-avatar">
            <PersonaAvatar name={selectedPersona} size={18} />
          </span>
          <select
            className="persona-select"
            value={selectedPersona}
            onChange={(e) => {
              if (e.target.value === '__new__') { onNewProfile(); return; }
              onPersonaChange(e.target.value);
            }}
            disabled={activeSessionHasMessages}
            title={activeSessionHasMessages ? '当前对话已绑定画像，切换画像将新建对话' : '选择用户画像'}
          >
            <option value="">通用模式</option>
            {personas.map((p) => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
            <option value="__new__">+ 新建画像…</option>
          </select>
        </div>
        {showHint && personas.length > 0 && (
          <div className="persona-hint">运营多个账号？在这里切换画像</div>
        )}
      </div>

      <nav className="sidebar-nav">
        {NAV.map(({ page, Icon, label }) => (
          <button
            key={page}
            className={`nav-item ${currentPage === page ? 'active' : ''}`}
            onClick={() => onPageChange(page)}
          >
            <span className="nav-icon"><Icon size={18} /></span>
            {label}
          </button>
        ))}
      </nav>

      <div className="sidebar-section">
        <div className="sidebar-section-header">
          <span className="sidebar-section-title">对话</span>
          <button className="new-chat-btn" onClick={onNewChat} title="新建对话">
            <IconNewChat size={13} /> 新对话
          </button>
        </div>
        {active.map((s) => renderItem(s, false))}

        {archived.length > 0 && (
          <>
            <div className="archived-header" onClick={() => setShowArchived((v) => !v)}>
              <span className={`archived-chevron ${showArchived ? 'open' : ''}`}><IconChevron size={12} /></span>
              已归档 · {archived.length}
            </div>
            {showArchived && archived.map((s) => renderItem(s, true))}
          </>
        )}
      </div>

      <div className="sidebar-status">
        <span className={`status-dot ${gatewayStatus === 'connected' ? '' : 'offline'}`} />
        {gatewayStatus === 'connected'
          ? '网关已连接'
          : gatewayStatus === 'disconnected'
            ? '网关离线'
            : '连接中…'}
        <button className="settings-gear" onClick={onOpenSettings} title="设置（模型 · 环境 · 更多）">
          <IconGear size={13} /> 设置
        </button>
        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--text-tertiary)' }}>subnav-1</span>
      </div>
    </div>
  );
}
