# Easel 定制版迁移方案:用 Claude Agent SDK 替换 OpenClaw

> 状态:方案评审稿(仅方案与计划,未开始实现)
> 日期:2026-10-01
> 适用:基于当前 Easel(main@c08eba6)的自定义实现

---

## 0. 摘要

用 **Claude Agent SDK(Python)** 进程内嵌入 FastAPI 后端,替换 OpenClaw gateway 及其全部集成层。
Easel 的核心资产——**114 个 SKILL、媒体/发布脚本、Playwright 登录与发布、画像体系、outputs 归档、React 前端**——均为自有 Python/TS 代码,与 OpenClaw 无耦合,**原样保留**。

被替换的净代码量约 **1500–2000 行**,且全部是适配 OpenClaw 协议 quirks 的"胶水"(双传输路径、profile 端口哈希、Ed25519 设备配对桥、raw-stream tail hack);替换后其中大半**删除而非重写**。SDK 侧新增约 600–800 行(六个内聚模块)。

- **工期估算**:单人 4–7 周,五个阶段。
- **最大取舍**:一期仅支持 Anthropic 协议模型(官方 API / `ANTHROPIC_BASE_URL` 兼容端点 / 本机 Claude Code 登录免 key);OpenAI 兼容模型降级为 Phase 5 可选项(LiteLLM sidecar),Gemini CLI 免 key 能力放弃。
- **性价比核心**:现有 SKILL.md 的 frontmatter(`name`+`description`)与 Claude Code Agent Skills 规范**同构**,技能近乎零改写迁移。

---

## 1. 背景与目标

### 1.1 为什么要替换

当前 Easel 依赖 OpenClaw(Node 网关)作为 Agent 运行时,为适配它,Python 侧积累了大量协议胶水,并且带来一类只能靠补丁对抗的问题:

- 双传输路径(HTTP SSE 直连 vs CLI 子进程)必须保证**会话永不换边**,否则静默丢历史(`web/app.py:2109`);
- OpenClaw session-key 绑定空闲 24h 过期 → 用 uuid5 钉死 transcript 补救(`web/app.py:2086`);
- ask_user 卡片要走 gateway `question.*` RPC + **Ed25519 设备配对**桥(`easel/gateway_questions.py`,391 行);
- 流式输出靠 tail gateway 写的**共享 raw stream jsonl** + runId 闩锁隔离(`web/app.py:2358` 起的 supervisor);
- profile 端口是 FNV 哈希(37289)、workspace 布局随版本漂移(issue #19)——`easel/gateway_endpoint.py`、`easel/openclaw_workspace.py` 整个模块都在对抗这些。

### 1.2 目标

1. Agent 运行时收敛为**单一路径**:Claude Agent SDK,进程内嵌,无独立 gateway 进程;
2. SKILL 资产**零改写**(或仅同步期路径规整)迁移;
3. Web 前端与 SSE 事件协议**完全不变**(`token`/`thinking`/`activity`/`error`/`done` + 问答题卡片);
4. 会话跨重启、跨长期空闲**原生持久化**,消灭"绑定过期丢历史"类 bug;
5. 保留三道既有脚本门禁(`model_registry.py` 脱敏配置查询、`content_guard.py` 发布安全硬拦、`persona_gate.py` 人设一致性提醒)。

### 1.3 非目标(一期不做)

- 多供应商对话模型路由(OpenAI 兼容、Gemini)——降级为可选项(见 §5.6);
- 把技能脚本改造成 MCP 工具(仍走 Bash 执行);
- 发布链路改造(发布本就不走 agent 聊天路径,`/api/publish/*` 原样保留)。

---

## 2. 现状分析:OpenClaw 承担的职责

### 2.1 替换面清单(9 项)

| # | 职责 | 现状代码位置 | 复杂度 |
|---|---|---|---|
| 1 | 常驻 gateway 进程 + profile 端口解析(FNV 哈希 → 37289) | `easel/gateway_endpoint.py`(178 行) | 中 |
| 2 | 双传输路径:HTTP `/v1/chat/completions` SSE 直连 vs `openclaw agent` CLI 子进程;transport pin + uuid5 transcript 钉死保证会话不换边 | `web/app.py:2109-2164`(解析)、`web/app.py:2358-2950`(流式主循环) | **高** |
| 3 | prompt 栈挂载:SOUL.md / AGENTS.md / CONTEXT.md → system prompt;运行时项目根注入 | `openclaw/workspace/`、`openclaw/sync.sh`(追加段) | 低 |
| 4 | 技能同步:114 个 SKILL 拷入 `workspace/skills/`;`shared/` 拷入 `workspace/shared/`;profiles 符号链接为 `easel-profiles` | `openclaw/sync.sh`、`easel/openclaw_workspace.py`(160 行) | 中 |
| 5 | ask_user 问答题卡片桥:gateway `question.*` RPC + Ed25519 设备配对(v2 payload) | `easel/gateway_questions.py`(391 行) | **高** |
| 6 | 流式输出:tail 共享 raw stream jsonl + runId 闩锁 → SSE `token`/`thinking` | `web/app.py:2358-2950` | **高** |
| 7 | 会话治理:跨进程 flock、session heal(清洗 thinking 块)、24h 绑定过期补丁 | `web/app.py:2078-2230`、`web/app.py:177` 起 | 中 |
| 8 | 模型路由:openclaw.json providers、本地 CLI 登录态复用(claude-cli / google-gemini-cli)、设置页模型通道双向同步 | `easel/local_agents.py`(202 行)、`web/app.py:1288-1865`(约 600 行) | 中 |
| 9 | 运维:`easel gateway start/stop`、doctor(9+ 检查项)、ping、setup.sh 安装 openclaw + profile | `easel/commands/*`、`setup.sh`、`scripts/gateway.*` | 中 |

### 2.2 不属于替换范围的资产(原样保留)

| 资产 | 说明 |
|---|---|
| `skills/openclaw/*`(114 个 SKILL) | SKILL.md + references/ + 脚本;frontmatter 与 Claude Code Agent Skills 同构 |
| `skills/shared/scripts/*.py` | 全部媒体/发布/数据/门禁脚本(wordcount、model_registry、content_guard、persona_gate、calendar_ops、douyin_publish 等) |
| Playwright 登录与发布(`/api/login/*`、`/api/publish/*`) | 七平台;不走 agent 聊天路径 |
| `profiles/` 画像体系 + `easel/persona.py` | 画像以消息前缀内联(`persona_prefix` + 每轮 `TURN_REMINDER`,见 `easel/persona.py:91`) |
| `outputs/` 项目化归档 + 全部产物 API | `/api/outputs`、`/api/media/*`、上传、删除 |
| React 前端(`web/frontend/`) | 零改动 |
| 日历/选题/热点/数据看板 API | `/api/schedule`、`/api/ideas`、`/api/trends`、`/api/analytics/*` |
| `easel/timeouts.py` 超时单一真相源 | `TIMEOUT_PRODUCE=7200 / TIMEOUT_DIRECT=300 / TIMEOUT_CHAT=7200` 语义保留 |
| `.env` 媒体模型配置 | VIDEO/MUSIC/VOICE/EMBEDDING 等全部保留 |

---

## 3. Claude Agent SDK 能力映射

基于官方 Python SDK(`claude-agent-sdk`)文档核实(参考资料见附录 E):

| OpenClaw 现状 | SDK 对应物 | 迁移方式 |
|---|---|---|
| gateway 常驻进程 + CLI 子进程双传输 | `query()` / `ClaudeSDKClient` **进程内嵌入** | 单一路径;传输解析/探针/回退/钉子整体删除 |
| openclaw.json providers + 端口哈希 | `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` + `options.model` | 直读 `.env`,无配置文件、无端口 |
| transcript jsonl + uuid5 钉死 + 24h 过期 | SDK 原生会话持久化 + `resume=<session_id>` | web sessionId ↔ claude session_id 一张映射表;`~/.claude/projects/` 由 SDK 自管 |
| SOUL/AGENTS/CONTEXT 三层 prompt 栈 | `system_prompt` 参数 + 项目根 `CLAUDE.md`(`setting_sources=["project"]`) | AGENTS.md 正文 → CLAUDE.md;SOUL.md → system_prompt;运行时路径段由生成器拼入 |
| `workspace/skills/` 全量同步 | Claude Code **Agent Skills**:`.claude/skills/<name>/SKILL.md` | 目录同步 + frontmatter 校验;references/scripts 按需加载机制一致 |
| `question.*` RPC + Ed25519 桥 | 自定义 **SDK MCP 工具** `ask_user`(asyncio.Event 阻塞) | 391 行桥接删除,换 ~100 行工具 + 本地 question store |
| 共享 raw stream tail hack | `include_partial_messages=True` → `StreamEvent` | 原生增量事件直接映射 SSE |
| `--thinking` 级别 | `options.thinking` | 直传 |
| `--timeout-ms` | 无同名参数:`max_turns` 兜底 + 应用层 `asyncio.timeout` 包裹消息循环 | 保留 `easel/timeouts.py` |
| 无权限模型(openclaw 全放行) | `permission_mode` / `allowed_tools` / `can_use_tool` / hooks | 见 §5.5 |
| 复用 Claude Code 登录态免 key | SDK 天然复用本机 Claude Code 登录(OAuth) | 保留且更直接;`local_agents.py` 简化为仅探测 claude |
| `easel gateway` / doctor gateway 检查 / `ping` 探端口 | 删除;doctor/ping 换检查项 | 见附录 C |

---

## 4. 目标架构

```
┌────────────────────────── easel web (FastAPI, 单进程) ─────────────────────────┐
│                                                                                │
│  现有 API 层(不动):personas / skills / outputs / upload / login / publish     │
│                    / analytics / schedule / ideas / trends / env               │
│                                                                                │
│  ── 替换层 ─────────────────────────────────────────────────────────────────  │
│  /api/chat/stream ──► easel/agent/runner.py (AgentRunner)                      │
│                        ├─ claude_agent_sdk.ClaudeSDKClient(每会话一个)         │
│                        ├─ sessions.py   web sessionId ↔ claude session_id 映射 │
│                        ├─ events.py     StreamEvent → SSE 协议(前端零改动)     │
│                        ├─ ask_user.py   SDK MCP 工具:ask_user(阻塞等答题)      │
│                        ├─ prompts.py    CLAUDE.md 生成 + SOUL system_prompt    │
│                        ├─ skills_sync.py  skills/openclaw → .claude/skills     │
│                        └─ permissions.py  can_use_tool 策略(一期从宽)          │
│                                                                                │
│  options.cwd = 项目根(SKILL 脚本 `python3 skills/shared/scripts/*.py` 原样可跑)│
└────────────────────────────────────────────────────────────────────────────────┘
        │ SDK 内部:Node 子进程运行捆绑的 Claude Code cli.js
        ▼
   Anthropic API / ANTHROPIC_BASE_URL 兼容端点 / 本机 Claude Code 登录态
```

**`cwd = 项目根` 是技能零改写的前提**:AGENTS.md"先 cd 到项目根再跑脚本"的规则天然满足,`skills/shared/scripts/`、`profiles/`、`outputs/`、`.env` 全部按现有项目根相对路径工作。

### 4.1 新增模块职责

| 模块 | 职责 |
|---|---|
| `easel/agent/runner.py` | 封装 `ClaudeSDKClient` 生命周期:创建/续接/中断/超时;每会话一个 client;组装 `ClaudeAgentOptions`(cwd、model、env 代理、system_prompt、setting_sources、mcp_servers、hooks);supervisor 模式(断线不杀、结果落盘)沿用现有 turn event file 机制 |
| `easel/agent/sessions.py` | 会话映射注册表:`web_session_id → {claude_session_id, persona, created_at, updated_at}`,JSON 落盘;首轮从 `ResultMessage.session_id` 采集;`resume` 续接;删除会话 = 删映射(孤儿 transcript 留待清理) |
| `easel/agent/events.py` | SDK 消息 → SSE 事件映射:`StreamEvent` 的 `text_delta`→`token`、`thinking_delta`→`thinking`;`AssistantMessage` 的 `ToolUseBlock`→`activity`("🔧 正在执行操作…");`ResultMessage`→`done`;**事件名与负载形状与现状完全一致** |
| `easel/agent/ask_user.py` | SDK MCP server(`create_sdk_mcp_server` + `@tool`):`ask_user(question, options?, allow_text?)` → 建 pending question → 经 SSE 推卡片 → `asyncio.Event` 阻塞等答案 → 结构化结果返回给模型;答案落本地 store(替代 gateway RPC) |
| `easel/agent/prompts.py` | CLAUDE.md 生成器:AGENTS.md 正文(去 OpenClaw 措辞)+ "运行时项目根"段;SOUL.md 读入 `system_prompt`;`_chat_message` 的画像前缀 + 每轮提醒逻辑不变(`easel/persona.py` 复用) |
| `easel/agent/skills_sync.py` | 同步 `skills/openclaw/* → .claude/skills/*`,frontmatter 校验(name 与目录一致、description 非空);处理 `../../shared/` 路径规整(见附录 D);供 setup/doctor/启动时调用 |
| `easel/agent/permissions.py` | `allowed_tools` 白名单 + `can_use_tool` 回调;一期从宽(见 §5.5) |

### 4.2 删除清单

| 目标 | 内容 |
|---|---|
| 整文件删除 | `easel/gateway_endpoint.py`、`easel/openclaw_workspace.py`、`easel/openclaw_cmd.py`、`easel/gateway_questions.py`;`openclaw/` 目录(config 模板、sync.sh、workspace);`scripts/gateway.sh`、`scripts/gateway.ps1` |
| `web/app.py` 内删除 | 传输解析/heal/raw-stream-tail/CLI 子进程分支(约 800 行);openclaw 模型通道同步 `_model_channels`/`_sync_openclaw_chat`/`_sync_anthropic_provider` 等(约 600 行,`web/app.py:1288-1865`);`_local_ports` 等端口治理 |
| `easel/` 内简化 | `local_agents.py` → 仅探测 claude 登录态(供免 key 提示);`easel gateway` 子命令删除;`doctor`/`ping` 重写(附录 C) |
| `setup.sh` / `setup.ps1` | 删除 openclaw 安装、`--profile easel` 创建、workspace sync 段;保留 Python/Node/FFmpeg/Chromium/前端构建/`.env` 引导 |

---

## 5. 关键设计决策(附理由)

### 5.1 Python SDK、进程内嵌,而非独立 agent 服务

后端是 FastAPI,Python SDK 的异步迭代器与事件循环直接对接 SSE,共享 `.env`、锁、内存态。`AgentRunner` 保持薄接口,未来需要多客户端/多机再拆分;一期不付分布式复杂度。SDK 每个会话维护一个 Node 子进程(运行捆绑的 cli.js),这是 SDK 的固定成本,需在 Phase 4 验证多会话并发的内存占用。

### 5.2 会话持久化用 SDK 原生 `resume`

首轮 `query()` 从 `ResultMessage.session_id` 取会话 ID 落映射;之后每轮 `resume=<claude_session_id>`。SDK transcript 在 `~/.claude/projects/` 自管,跨重启、跨长期空闲不丢——**OpenClaw"绑定过期丢历史"整类 bug 从根上消失**,session heal、uuid5 钉死、flock(不再有第二个写 transcript 的进程)随之删除。同会话串行保留 asyncio 锁(现状 `_session_lock`)。

### 5.3 技能零改写迁移(性价比核心)

现有 SKILL.md frontmatter 与 Claude Code Agent Skills 规范同构:`description` 触发 + 正文渐进披露 + `references/` 按需读取,机制完全一致;`layer: produce` 等扩展字段对 loader 无害。迁移 = 目录同步。风险点在 **114 个技能 description 的触发质量**(冲突/过时/互相重叠),对策:Phase 1 建 30 case 冒烟集回归,不达标者集中修一轮 description(只改触发文案,不改技能逻辑)。

### 5.4 ask_user 换成 SDK MCP 工具,而非复刻 gateway 机制

不复刻 `question.*` RPC/设备配对。模型侧调用 `mcp__easel__ask_user` → 工具实现挂起等待 web 层答案 → 结构化返回。相比现状的改进:答案可达性由我们自己保证,不再有 900s 超时静默 `no_answer`;`EASEL_ASKUSER_CARDS` 开关与版本探测逻辑随之删除。

### 5.5 权限一期从宽,门禁靠既有脚本

`permission_mode="acceptEdits"` + `allowed_tools` 白名单(Bash / Read / Write / Edit / Skill / `mcp__easel__*`)。付费操作确认、发布安全、人设一致性**继续由现有三道脚本门禁承担**——它们不依赖 OpenClaw,语义不变。`can_use_tool` 一期只做日志与兜底(如 outputs/ 外写入告警),二期按需收紧。

### 5.6 模型接入:一期 Anthropic 协议 only(本方案最大取舍)

SDK 原生支持:官方 API、`ANTHROPIC_BASE_URL` 指向 Anthropic 兼容端点(覆盖 `.env.example` 的 `EASEL_LLM_*` 场景)、本机 Claude Code 登录免 key(OAuth)。**OpenAI 兼容模型(gpt-4o 等)不在原生射程内**:Phase 5 提供 LiteLLM sidecar 可选接入(`OPENAI_*` 配置翻译为 Anthropic 协议);**Gemini CLI 免 key 能力放弃**(如后续有需求,作为独立旁路模块另议)。需产品侧确认可接受。

### 5.7 前端与 SSE 协议完全不变

`events.py` 保证事件名与负载形状与现状一致;`/api/chat/question/answer`、`/status` 形状不变(内部实现从 gateway RPC 换成本地 store)。React 前端一行不改。`/api/chat/stop` → `ClaudeSDKClient.interrupt()`;"断线不杀、结果落盘、`/api/chat/last` 取回"语义沿用。

### 5.8 长会话画像保持

现状已知取舍是"画像随消息内联,超长会话压缩后可能丢"。SDK 下先沿用内联前缀(`easel/persona.py` 原样);Phase 4 验证 PreCompact 行为后,如有必要用 SessionStart hook / 压缩后重注入画像摘要兜底。全局 `MEMORY.md`/`USER.md` 污染问题在 SDK 下不存在(无全局记忆文件;CLAUDE.md 是静态项目级)。

---

## 6. 分阶段实施计划

### Phase 0 — 骨架与 PoC(0.5–1 周)

- 新仓库(或新分支),vendor 无关资产:skills/、profiles/、web/frontend、skills 脚本;
- `pip install claude-agent-sdk`;Node 版本检查(cli.js 需 Node 18+,前端构建保留现有下限);
- **PoC 四点验证**(详见附录 A,任一不通则方案回炉):
  1. `.claude/skills` 现有技能正确触发并跑通脚本;
  2. `resume` 续会话;
  3. `include_partial_messages=True` 拿到 token/thinking 增量;
  4. 自定义 SDK MCP 工具阻塞等待外部答案后继续。
- **退出标准**:一条命令跑通"带技能的问答 + 流式输出 + 会话续接"。

### Phase 1 — Agent 运行时核心(1–2 周)

- 实现 `easel/agent/` 七个模块(§4.1);
- prompt 迁移:CLAUDE.md 生成器 + SOUL system_prompt,措辞去 OpenClaw 化(含 `easel-profiles/` → `profiles/`、workspace 措辞调整);画像前缀 + 每轮提醒机制不变;
- `skills_sync.py` 同步 + 校验 + `../../shared/` 路径规整(附录 D);
- **技能触发冒烟集**:30 个代表性 case(每层 6 个)回归"该触发的触发了、references 读取路径正确、脚本在项目根跑通";
- 单测:runner(mock agent)、session 映射、CLAUDE.md 生成、ask_user 状态机。

### Phase 2 — Web 后端切换(1–2 周)

- `/api/chat/stream` 重写为 SDK 流(supervisor 模式沿用:客户端断开只结束 forward,agent 跑到底、结果落盘);
- 适配 `/api/chat/last`、question answer/status、`/api/chat/stop`(interrupt);
- 删除传输层与 openclaw 模型同步代码(§4.2);设置页模型配置简化为 Anthropic 三项 + auth 来源展示(API key vs 本机登录);
- 会话列表/删除适配 SDK transcript 映射;
- **验收**:全功能走查——选画像 → 对话 → 技能触发产出文件到 outputs/ → 日历回写 → 断线重连取回 → 问答题卡片。

### Phase 3 — CLI 与安装器(0.5–1 周)

- `easel chat` 改为薄客户端走同一 runner(经本地 web API,保证会话单一真相源;未启动时自动拉起);
- `doctor` 重写(附录 C);`ping` 变为一次最小 query 往返;
- `setup.sh` / `setup.ps1` 删 openclaw 段;`sync.sh` → `sync_skills.sh`(.claude/skills)。

### Phase 4 — 长任务与稳定性(1 周)

- 制作层 2h 预算(`TIMEOUT_CHAT`)应用层实现:`asyncio.timeout` 包裹消息循环,超时 interrupt + 可读错误;`max_turns` 兜底(建议 100,可配);
- 同会话串行(asyncio 锁)、跨会话并行验证(多 Node 子进程内存占用评估);
- 代理 env 经 `options.env` 透传(沿用 `_proxy_env()` 语义);错误分类(连接失败/超时/权限拒绝 → 前端可读信息);
- PreCompact 后画像保持验证;可选 `max_budget_usd`。

### Phase 5 — 清理与发布(0.5 周)

- 删除全部 openclaw* 代码;文档更新(README / prompt-stack.md / SKILL-SPEC.md / known-issues);e2e;CHANGELOG;
- 可选项:LiteLLM sidecar 支持 OpenAI 兼容模型;用 SDK `agents`(subagents)按五层(发现/策划/制作/发布/归因)拆分探索型 agent。

**总量估算:单人 4–7 周。关键路径是 Phase 0 四点 PoC 与 Phase 1 技能触发回归;其余多为删代码 + 重接线。**

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 114 个 SKILL 的 description 触发质量(冲突、过时、互相重叠) | Phase 1 冒烟集回归;不达标集中修一轮 description(只改触发文案不改逻辑) |
| OpenAI 兼容模型 / Gemini CLI 免 key 能力丢失 | 一期明确取舍;Anthropic 兼容端点覆盖主流中转;LiteLLM 作为 Phase 5 可选项;Gemini 需求另立旁路 |
| SDK 迭代快、API 变动 | pin 版本;`AgentRunner` 单点隔离,升级只动一个模块 |
| 长会话上下文压缩丢画像 | 一期沿用内联前缀;Phase 4 验证后用 SessionStart hook / 压缩后重注入兜底 |
| 对外文案泄露工具名 | `content_guard.py` 硬拦保留;SOUL/AGENTS 改写时同步去除 OpenClaw 字样,避免"提醒但不硬拦"类措辞变成"Claude" |
| Windows 兼容(SDK 依赖 Node 运行捆绑 cli.js) | 不再有 .cmd shim 问题(不经 PATH 调外部 CLI);doctor 检查 Node 版本即可,`openclaw_cmd.py` 那套解析整体作废 |
| 多会话并发 = 多 Node 子进程的内存/句柄占用 | Phase 4 压测;必要时按会话空闲超时回收 client(下次 `resume` 重建,成本可接受) |
| 问答题卡片与长阻塞工具的超时交互 | ask_user 工具内设独立于 `TIMEOUT_CHAT` 的等待上限,并在 SSE 活动事件中可见倒计时 |

---

## 附录 A — PoC 四点验证

| # | 验证点 | 最小验证方式 | 判定 |
|---|---|---|---|
| A1 | Agent Skills 触发与执行 | 取 3 个技能(1 个纯文案类如 `copywriting`、1 个脚本类如 `card-xiaohongshu`、1 个跨引用类)放入 `.claude/skills`,`query()` 触发;确认 SKILL.md 正文被读、references 可读、脚本在项目根执行、产物落 outputs/ | 产物真实生成 |
| A2 | 会话续接 | 首轮告知一个事实 → 取 `ResultMessage.session_id` → 新 query `resume` 追问 | 事实被记住 |
| A3 | 流式增量 | `include_partial_messages=True` 消费 `StreamEvent`,区分 `text_delta` / `thinking_delta` | 增量实时可见、无重复 |
| A4 | 自定义 MCP 工具阻塞等待 | `create_sdk_mcp_server` 注册 `ask_user`,工具内 `await event.wait()`;外部 5s 后 set | 模型拿到答案后继续;超时路径可测 |

## 附录 B — `.env` 变更对照

| 键 | 现状 | 新方案 |
|---|---|---|
| `ANTHROPIC_API_KEY` | 保留 | 保留(或省略以复用本机 Claude Code 登录) |
| `ANTHROPIC_BASE_URL` | 无(openclaw.json baseUrl) | **新增**,Anthropic 兼容端点 |
| `CLAUDE_MODEL=anthropic/claude-sonnet-4-6` | OpenClaw provider/model 格式 | 改为纯模型 id(如 `claude-sonnet-4-5`),去掉 provider 前缀 |
| `EASEL_LLM_*`(Anthropic-compatible) | 保留 | 保留,映射到 `ANTHROPIC_BASE_URL`/`ANTHROPIC_API_KEY` |
| `OPENAI_*` | OpenClaw provider | Phase 5 前**不生效**(可选 LiteLLM 时再启用);设置页如实标注 |
| `EASEL_GATEWAY_PORT` | gateway 端口 | **删除**(无 gateway) |
| 媒体类(VIDEO/MUSIC/VOICE/EMBEDDING/DASHSCOPE…) | 保留 | 全部保留,不动 |

## 附录 C — doctor / ping 检查项对照

| 现状检查 | 新方案 |
|---|---|
| Python ≥ 3.10 / venv / FFmpeg / Playwright Chromium / 前端构建 / Python 包 | **保留不动** |
| Node.js ≥ 下限 | 保留(SDK cli.js 需 Node 18+;取前端构建与 SDK 的较大者) |
| `openclaw command` | 替换为:`claude-agent-sdk` 可导入 + 捆绑 cli 存在 |
| `.env (API Key)` | 扩展:显示 auth 来源(API key / 本机 Claude Code 登录),二者有一即可 |
| OpenClaw model routing / gateway / Skills synced | 替换为:auth 有效 ping(最小 query)、`.claude/skills` 同步校验(frontmatter)、CLAUDE.md 已生成 |
| 本机 agent CLI | 简化:仅探测 claude 登录态(免 key 提示) |

`easel ping` 语义:对配置的模型端点发起一次最小 query,测真实往返(替代探端口/healthz)。

## 附录 D — 迁移适配细节

1. **`../../shared/` 引用**:现状 workspace 布局中 `workspace/skills/<name>/` 经 `../../shared/` 命中 `workspace/shared/`;新布局 `.claude/skills/<name>/` 的 `../../` 是项目根,`shared/` 不存在。两种解法,**优先 a**:
   a. 同步期路径规整:同步时把 SKILL.md 内 `../../shared/` 重写为 `skills/shared/`(项目根相对,`cwd` 下成立);源文件不动;
   b. 兜底:同步 `skills/shared/ → .claude/shared/` 保持相对结构。
   (项目根相对写法 `skills/shared/scripts/wordcount.py` 本就成立,不受影响。)
2. **AGENTS.md 措辞**:"OpenClaw workspace"相关规则(不在 workspace 跑脚本、`easel-profiles/` 符号链接)改写为项目根语义(`profiles/`);SOUL.md 中 OpenClaw 字样去除;对外不暴露工具名的红线保留并覆盖新工具名。
3. **运行时项目根注入**:sync.sh 的 AGENTS.md 追加段由 `prompts.py` 生成器承担(写入 CLAUDE.md 尾部)。
4. **USER.md / MEMORY.md 清理**:不再需要(SDK 无全局记忆文件;账号记忆仍按画像走 `profiles/<X>/memory.md`)。
5. **每轮提醒**:`easel/persona.py` 的 `chat_turn_message`(画像前缀 + 用户原文 + `TURN_REMINDER`)原样复用,作为发给 SDK 的 user message。

## 附录 E — 参考资料

- Agent SDK reference – Python:<https://code.claude.com/docs/en/agent-sdk/python>
- anthropics/claude-agent-sdk-python:<https://github.com/anthropics/claude-agent-sdk-python>
- Claude Code Agent Skills(SKILL.md 规范):<https://code.claude.com/docs/en/skills>
