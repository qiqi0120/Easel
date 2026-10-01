# 侧栏画像切换器增强 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让侧栏的画像切换入口一眼可见：下拉框视觉增强（头像圆点＋更醒目样式）、首次使用引导高亮、会话列表显示所属画像圆点。

**Architecture:** 纯前端改动，只动 `web/frontend/src/components/Sidebar.tsx` 和 `web/frontend/src/styles/index.css`。`Sidebar` 已持有 `personas`、`selectedPersona`、`sessions` 全部所需数据，无新增请求、无后端改动。头像圆点颜色由画像名哈希从 6 色 CSS 变量色板选取，三处（下拉框、引导、会话列表）复用同一组件与色板。

**Tech Stack:** React 19 + TypeScript + Vite（无单测框架）；样式为全局 `index.css`（CSS 变量主题）。

**Spec:** `docs/superpowers/specs/2026-10-01-persona-switcher-enhancement-design.md`

## Global Constraints

- 只允许修改两个文件：`web/frontend/src/components/Sidebar.tsx`、`web/frontend/src/styles/index.css`。不改 `App.tsx`、不改后端、不新增依赖、不引入组件库。
- 保留原生 `<select>`（键盘/无障碍友好），保留 `＋ 新建画像…` 选项与禁用逻辑。
- 不改画像切换行为（`App.tsx` 的 `handlePersonaChange`：当前会话有消息时切换画像自动新建对话）。
- 配色只用现有 CSS 变量体系；新色板值对齐 `:root` 里 `--layer-*` 六色（浅色主题，无需暗色适配）。
- 提交信息用 `feat(web): ...` 风格（对齐 git log 现有惯例）。
- 本仓库前端无单测框架（`tests/` 是 pytest 后端测试），每个任务的自动化验证 = `npm run lint`（oxlint）+ `npm run build`（`tsc -b` 类型检查 + vite 构建）；手动验收在 FastAPI 服务的页面（`npm run build` 后硬刷新）进行——vite 未配置代理，`npm run dev` 下拿不到 `/api` 数据，不要用它做验收。

## File Structure

- `web/frontend/src/components/Sidebar.tsx`（Modify）
  - 顶部新增 `PERSONA_PALETTE_SIZE`、`personaColorIndex()`、`PersonaAvatar` 组件（Task 1）
  - `sidebar-header` 里把 `<select>` 包进 `.persona-field` 并叠加当前画像头像（Task 1）
  - 新增 `showHint` 状态 + `dismissHint` + 引导文案渲染（Task 2）
  - `renderItem` 会话条目插入画像圆点（Task 3）
- `web/frontend/src/styles/index.css`（Modify）
  - `:root` 追加 `--persona-c1..c6`（Task 1）
  - `.persona-avatar` / `.persona-field` / `.persona-field-avatar` 样式，重写 `.persona-select`（Task 1）
  - `.persona-field.hint` 光晕动画 + `.persona-hint` 提示条（Task 2）
  - `.session-persona-dot`（Task 3）

---

### Task 1: 头像圆点组件与下拉框视觉增强

**Files:**
- Modify: `web/frontend/src/components/Sidebar.tsx`
- Modify: `web/frontend/src/styles/index.css`

**Interfaces:**
- Consumes: props 里已有的 `personas: PersonaItem[]`（`{ name, description }`）与 `selectedPersona: string`。
- Produces: `PersonaAvatar({ name, size }: { name: string; size?: number })`（name 为空串渲染灰色圆点；否则彩色圆点＋首字，`size < 12` 时只渲染色点不渲染首字）；CSS 类 `.persona-field`、`.persona-field-avatar`、`.persona-avatar`（`.generic` 修饰）、CSS 变量 `--persona-c1..c6`。Task 2 用 `.persona-field`，Task 3 复用 `PersonaAvatar`。

- [ ] **Step 1: index.css — `:root` 追加画像色板**

在 `:root` 的 `--layer-general: #64748b;` 一行之后插入：

```css
  /* ---- Persona avatar palette（画像头像圆点，按名字哈希轮转，取值对齐 --layer-* 六色）---- */
  --persona-c1: #0ea5e9;
  --persona-c2: #7c3aed;
  --persona-c3: #db2777;
  --persona-c4: #059669;
  --persona-c5: #d97706;
  --persona-c6: #64748b;
```

- [ ] **Step 2: index.css — 新增头像样式并重写 `.persona-select`**

把现有这段（约 118–134 行）：

```css
.persona-select {
  width: 100%;
  padding: 9px 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text);
  font-size: 13px;
  cursor: pointer;
  outline: none;
  appearance: none;
  transition: border-color var(--t-fast);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a0a0aa' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
}
.persona-select:focus { border-color: var(--accent-start); }
```

整体替换为：

```css
.persona-field { position: relative; }

.persona-field-avatar {
  position: absolute; left: 12px; top: 50%; transform: translateY(-50%);
  pointer-events: none; z-index: 1;
  display: inline-flex;
}

.persona-avatar {
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 50%;
  color: #fff;
  font-weight: 700;
  line-height: 1;
  flex: none;
  user-select: none;
}
.persona-avatar.generic { background: var(--text-tertiary); }

.persona-select {
  width: 100%;
  padding: 10px 30px 10px 38px;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  color: var(--text);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  outline: none;
  appearance: none;
  transition: border-color var(--t-fast);
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%23a0a0aa' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
}
.persona-select:hover:not(:disabled) { border-color: var(--text-tertiary); }
.persona-select:focus { border-color: var(--accent-start); }
.persona-select:disabled { cursor: not-allowed; opacity: 0.6; }
```

注意：`background: var(--bg-elev)` 必须保持在 `background-image` 之前（shorthand 会重置 image，原代码即依赖此顺序）。

- [ ] **Step 3: Sidebar.tsx — 新增 PersonaAvatar 组件**

在 `const NAV: ... = [...]` 数组结束后、`export default function Sidebar(` 之前插入：

```tsx
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
```

- [ ] **Step 4: Sidebar.tsx — 用 `.persona-field` 包住 select 并叠加头像**

把 `sidebar-header` 里现有的：

```tsx
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
```

整体替换为（select 的属性原样保留，只包一层并加头像）：

```tsx
        <div className="persona-field">
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
```

- [ ] **Step 5: lint + build 验证**

```bash
cd /Users/yuzhe/AIDev/easel/web/frontend && npm run lint && npm run build
```

Expected: oxlint 0 error；`tsc -b` 无类型错误；vite 正常产出 `dist/assets/index-*.js`。

- [ ] **Step 6: 手动验收**

保持 FastAPI 服务运行，浏览器硬刷新前端页（Cmd+Shift+R）。检查：
1. 侧栏顶部下拉框明显变大（约 40px 高、14px 字），左侧有头像：选中「互联网大厂技术总监」时是彩色圆点＋首字「互」；选「通用模式」时是灰色实心圆点。
2. 切换到另一个画像（或先在画像页建一个），圆点颜色随画像变化且同一画像颜色稳定。
3. 当前会话有消息时下拉框仍禁用（变半透明、不可点）。
4. 首字符为 emoji/生僻字的画像名不崩（哈希用 codePointAt，任意字符安全）。

- [ ] **Step 7: Commit**

```bash
git add web/frontend/src/components/Sidebar.tsx web/frontend/src/styles/index.css
git commit -m "feat(web): 画像切换器视觉增强（头像圆点＋更醒目下拉框）"
```

---

### Task 2: 首次引导高亮

**Files:**
- Modify: `web/frontend/src/components/Sidebar.tsx`
- Modify: `web/frontend/src/styles/index.css`

**Interfaces:**
- Consumes: Task 1 的 `.persona-field` 容器。
- Produces: CSS 类 `.persona-field.hint`（呼吸光晕）、`.persona-hint`（提示文字）；localStorage 键 `easel_persona_hint_seen`（值 `"1"`）。无导出符号。

- [ ] **Step 1: Sidebar.tsx — 常量与状态**

在文件顶部 import 之后、`export type Page = ...` 之前插入：

```tsx
const HINT_KEY = 'easel_persona_hint_seen';
```

在组件内 `const [showArchived, setShowArchived] = useState(false);` 之后插入：

```tsx
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
```

- [ ] **Step 2: Sidebar.tsx — 渲染光晕与提示**

把 Task 1 产出的：

```tsx
        <div className="persona-field">
```

改为：

```tsx
        <div
          className={`persona-field ${showHint && personas.length > 0 ? 'hint' : ''}`}
          onMouseDown={dismissHint}
        >
```

并在 `</div>`（`.persona-field` 的结束标签）与 `sidebar-header` 的结束 `</div>` 之间、即 `.persona-field` 之后插入：

```tsx
        {showHint && personas.length > 0 && (
          <div className="persona-hint">运营多个账号？在这里切换画像</div>
        )}
```

（`onMouseDown` 挂在容器上：点 select、点头像、甚至点了禁用的 select 都算“看见过”。）

- [ ] **Step 3: index.css — 光晕动画与提示条样式**

在 Task 1 的 `.persona-select:disabled` 一行之后追加：

```css
.persona-field.hint .persona-select {
  border-color: var(--accent-start);
  animation: persona-glow 1.8s ease-in-out infinite;
}
@keyframes persona-glow {
  0%, 100% { box-shadow: 0 0 0 0 rgba(21, 143, 154, 0); }
  50% { box-shadow: 0 0 0 4px rgba(21, 143, 154, 0.25); }
}
.persona-hint {
  margin-top: 6px;
  font-size: 12px;
  color: var(--text-secondary);
}
```

- [ ] **Step 4: lint + build 验证**

```bash
cd /Users/yuzhe/AIDev/easel/web/frontend && npm run lint && npm run build
```

Expected: oxlint 0 error；tsc/vite 无错误。

- [ ] **Step 5: 手动验收**

构建后硬刷新页面。检查：
1. 已有画像且首次（可先在 DevTools Console 执行 `localStorage.removeItem('easel_persona_hint_seen')` 复现）：下拉框出现青色呼吸光晕，下方一行小字「运营多个账号？在这里切换画像」。
2. 点击下拉框一次：光晕与提示立即消失。
3. 硬刷新：不再出现。
4. DevTools 执行 `localStorage.clear()` 后刷新：又出现一次（标记键生效验证）。

- [ ] **Step 6: Commit**

```bash
git add web/frontend/src/components/Sidebar.tsx web/frontend/src/styles/index.css
git commit -m "feat(web): 画像切换器首次引导高亮"
```

---

### Task 3: 会话列表画像圆点

**Files:**
- Modify: `web/frontend/src/components/Sidebar.tsx`
- Modify: `web/frontend/src/styles/index.css`

**Interfaces:**
- Consumes: Task 1 的 `PersonaAvatar`（`size < 12` 时渲染纯色点）与色板；`ChatSession.persona?: string`（`store.ts` 已有字段）。
- Produces: CSS 类 `.session-persona-dot`。无其它依赖方。

- [ ] **Step 1: Sidebar.tsx — renderItem 插入圆点**

在 `renderItem` 非重命名分支里，把：

```tsx
        <span className="session-item-title">{s.title}</span>
        <div className="session-actions">
```

改为（两条语句之间插入圆点）：

```tsx
        <span className="session-item-title">{s.title}</span>
        {s.persona && (
          <span className="session-persona-dot" title={`画像：${s.persona}`}>
            <PersonaAvatar name={s.persona} size={9} />
          </span>
        )}
        <div className="session-actions">
```

（`session-item-title` 是 `flex: 1`，圆点自然靠右；`.session-actions` 悬停才出现，出现时排在圆点之后。归档列表走同一个 `renderItem`，无需单独处理。）

- [ ] **Step 2: index.css — 圆点样式**

在 Task 2 的 `.persona-hint` 规则之后追加：

```css
.session-persona-dot { flex: none; display: inline-flex; margin-left: 4px; }
```

- [ ] **Step 3: lint + build 验证**

```bash
cd /Users/yuzhe/AIDev/easel/web/frontend && npm run lint && npm run build
```

Expected: oxlint 0 error；tsc/vite 无错误。

- [ ] **Step 4: 手动验收**

构建后硬刷新页面。检查：
1. 用画像 A 发一条消息（或找一条历史会话），侧栏该会话右侧出现 A 的颜色圆点（与下拉框头像同色），悬停显示「画像：A」。
2. 通用模式下的会话无圆点。
3. 会话标题很长时正常省略号截断，圆点不被挤出可视区（`session-item` 有 `overflow: hidden`）。
4. 悬停会话条目：圆点仍在，操作按钮出现在其右侧。

- [ ] **Step 5: Commit**

```bash
git add web/frontend/src/components/Sidebar.tsx web/frontend/src/styles/index.css
git commit -m "feat(web): 会话列表显示所属画像圆点"
```

---

## Final Verification（全部任务完成后）

- [ ] `cd /Users/yuzhe/AIDev/easel/web/frontend && npm run lint && npm run build` 通过。
- [ ] `git log --oneline -4` 显示 3 个 feat 提交。
- [ ] 完整走一遍规格验收清单（spec「测试与验收」5 条）：头像圆点显示、引导一次性出现/消失、切换画像后新会话带画像（发消息可见 Agent 收到画像前缀）、历史会话圆点正确、有消息会话下拉框禁用。
- [ ] 后端测试不涉及：`pytest tests/` 可选跑一遍确认无意外影响（本次未改任何 Python 文件，预期全绿）。
