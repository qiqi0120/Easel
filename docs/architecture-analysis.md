# Easel 架构分析：AI 用在哪里、为什么用 OpenClaw、设计理念是什么

> 分析对象：`/Users/yuzhe/AIDev/easel` @ `45eb145`
> 分析日期：2026-10-01
> 事实基线：本地代码 + `origin/main`（ZJU-REAL/Easel）对照。文中所有 `file:line` 均已实地核对。

---

## 0. 一句话结论

**Easel 自己几乎不写 AI 逻辑，它是一个"内容运营领域产品"，把 OpenClaw 当作 Agent 运行时（agent runtime），
自己只负责三件事：领域知识（114 个 Skill）、用户上下文（账号画像）、以及把产物交付到人眼前的界面与文件系统。**

用一句话概括分工：

```
Easel  =  领域知识 + 用户画像 + 交付界面
OpenClaw = 大脑 + 记忆 + 会话 + 工具调度 + 供应商适配
```

这个"薄壳 + 厚知识库"的形态，是理解整个项目一切设计取舍的起点。

---

## 1. 分层架构

```text
┌──────────────────────────────────────────────────────────────┐
│  接入层   Web 工作台 (React, :7860)      │  CLI (easel chat)  │
└───────────────┬──────────────────────────────────┬───────────┘
                │ HTTP + SSE                       │ 子进程
┌───────────────▼──────────────────────────────────▼───────────┐
│  编排层   web/app.py (FastAPI, 4717 行)  │  easel/ (14 文件)  │
│           拼消息 / 锁 / 流式 / 产物 API      │  拼消息 / 探活    │
└───────────────┬──────────────────────────────────┬───────────┘
                │ 画像前缀 + 附件 + TURN_REMINDER  │
┌───────────────▼──────────────────────────────────────────────┐
│  运行时   OpenClaw gateway (常驻, ws/http, 端口 37289)        │
│           ★ LLM 在这里被调用 ★                                │
└───────────────┬──────────────────────────────────────────────┘
                │ 读 SKILL.md → 调 scripts/ → 写文件
┌───────────────▼──────────────────────────────────────────────┐
│  知识层   114 SKILL.md  (skills/openclaw/, 按 layer: 标注)    │
│           + skills/shared/scripts/ (49 个 .py, 确定性工具为主) │
│           + profiles/<画像>/ (6 维账号上下文)                 │
└───────────────┬──────────────────────────────────────────────┘
                │ 写文件
┌───────────────▼──────────────────────────────────────────────┐
│  产物层   outputs/  ← 符号链接回项目根 (openclaw/sync.sh:146) │
└──────────────────────────────────────────────────────────────┘
```

**关键点：产物不走 API，走文件系统。**
Agent 的 CWD 在 OpenClaw workspace 里，但 `outputs/` 和 `easel-profiles/` 是指向项目根的符号链接
（`openclaw/sync.sh:138-154`），所以 agent 写文件即自动归位，前端再通过 `/api/outputs` + `/api/media` 呈现。
这条设计让"内容生产"完全可审计、可回溯，代价是重度依赖路径解析——这也是后面"胶水成本"的主要来源。

---

## 2. AI 到底用在哪里：三个**正交**的面

这是全项目最容易被误解的地方。很多人以为"Easel 是个 AI 应用"，实际上它的 AI 分成三套**互不相通**的体系。

### 2.1 面一：LLM 文本推理 —— 100% 委托给 OpenClaw

**证据：Easel 自己的依赖里一个 LLM SDK 都没有。**

`pyproject.toml:11-28` 的 27 个运行依赖中，**没有 openai / anthropic / litellm / transformers**，
网络能力只有 `httpx` 和 `websocket-client`。`docs/SKILL-SPEC.md:97` 明确写着：

> 所有调用统一走 OpenClaw agent，由 OpenClaw 读对应 SKILL、按 AGENTS.md 规则自己执行。

也就是说：**Easel 的 Python 代码里没有一次 LLM 推理调用。** 它只是把用户消息拼好，交给 OpenClaw。

模型配置在安装期一次性写进 OpenClaw 的 provider：

| 项目 | 值 | 位置 |
|---|---|---|
| 默认模型 | `anthropic/claude-sonnet-4-6` | `.env.example:10`、`setup.sh:429` |
| 认证优先级链 | Anthropic → Anthropic 兼容 → OpenAI → Auth Token → OpenAI MaaS → Gemini MaaS | `setup.sh:403-414` |
| 独立向量模型 | 可选；不配则退回关键词检索 | `.env.example:23-26` |

`setup.sh:501-563` 里注册了两个**协议适配器**，把内部 MaaS 伪装成 OpenAI 端点，让 OpenClaw 用
`openai-completions` 协议调用：

- `scripts/openai_maas_adapter.py:15,55` → provider `rednote-openai`，默认 `gpt-5.5`
- `scripts/gemini_maas_adapter.py:17,106,216` → provider `rednote-gemini`，默认 `gemini-3.1-pro-preview`，
  开 `thinkingLevel=HIGH` 并把 Gemini SSE 转成 OpenAI chunk，contextWindow 1048576

> ⚠️ 这两个文件在 **`origin/main`（上游 ZJU-REAL/Easel）里就存在**（已用 `git ls-tree origin/main` 核对），
> 不是本 fork 新增。公开学术仓库中出现内部 MaaS 适配器，建议你向上游确认一下它们的定位。

**skills 树里唯一一次直接 LLM 调用**（一个例外，很值得注意）：
`skills/openclaw/video-production/vendor/video-pipeline-sdk/tools/see.py:113` 用 urllib POST `/chat/completions`，
默认模型 `deepseek-chat`（`:35`），配置键 `VISION_BASE_URL/VISION_API_KEY/VISION_MODEL`。
这是 vendored 第三方 SDK 自带的"看图"工具，属于移植依赖，不是 Easel 自己的设计。

### 2.2 面二：生成式媒体 —— 完全独立的 provider 体系

媒体模型**不走 OpenClaw**，走自己的注册表 `skills/shared/scripts/model_registry.py:24-181`，
由各 SKILL 以 `python skills/shared/scripts/xxx.py` 子进程调用。

| 能力 | 脚本 | provider |
|---|---|---|
| AI 视频 | `ai_video.py` (42KB) | dashscope(通义万相) / ark(Seedance) / kling(可灵) / openai-compatible / xhs-maas / agnes |
| AI 图像 | `ai_image.py:5-9` | OpenAI 兼容 `/images/generations`·`edits`·`variations` / Agnes / apimart |
| 语音克隆 | `voice_clone.py` | CosyVoice / minimax / fish-audio / openai `/audio/speech` / gemini |
| AI 音乐 | `ai_music.py:5-6` | dashscope / suno-compatible |
| TTS | `tts.py:2-3,314` | **默认 edge-tts**；策略是"配了 VOICE_PROVIDER 走云端，edge 仅兜底" |
| ASR | `asr.py:1-2,40` | **本地 faster-whisper**（tiny→large-v3） |
| 抠图 | `remove_bg.py:33` | **本地 rembg/u2net** |

**这一层最值得学的设计判断是"确定性优先、模型兜底"：**

- `img_enhance.py:6-8` 在文件头主动声明：「这是**确定性传统增强**，不是 AI 超分辨率」——
  用 Pillow Lanczos + OpenCV 去噪。项目有意识地区分"确定性画质处理"和"生成式模型"。
- 抠图、语音转写用**本地模型**而不是云 API，降低成本和隐私暴露。
- 相比之下 LLM 面完全没有本地选项——**文本创作必须靠大模型，媒体制作尽量不用**。

### 2.3 面三：LLM + 确定性规则混合的"去 AI 感"治理

这是 Easel 最独特、也最被低估的一层。43 个文件涉及"去 AI 感"规则，它分两头治理：

**输入侧（用硬规则约束模型）：**

- 文本：`text-polisher/references/zh-ai-markers.md` 定义五维打分（直接性/节奏/信任度/活人感/精炼度），
  `text-polisher/SKILL.md:46-50` 设**两道门**：AI 味门 ≥45/50 → 综合门 ≥35/50
- 视觉：`card-design/references/anti-ai-slop.md` 列 P0/P1/P2 反例；
  `card-design/SKILL.md:35-36` 禁 emoji 当图标、禁蓝紫科技渐变（自称"头号 AI tell"）、禁玻璃拟态
- 设计哲学原话（`card-design/SKILL.md:11-14`）：
  > 没人做设计决定 = AI 选了一万张图的统计平均值 = 廉价
- 配套确定性质检门禁 `card_audit.py`（PIL + numpy 边缘密度），FAIL 必须重渲（`card-design/SKILL.md:25-29`）

**出站侧（分级闸门，避免误伤）：**
`content_guard.py:11-15` 把出站文本分两级——

- **BLOCK 级**（密钥/内网域名/代理 IP）：fail-closed，退出码 7，硬拦
- **WARN 级**（AI 措辞如 "system prompt"、"大模型"，模型名 `claude-*` / `gpt-image-2`）：**只告警，绝不拦截**

理由写在代码注释里：论文解读、AI 科普内容里这些词可能是正常的，硬拦会误伤。

> 这条设计的哲学是：**对内用硬规则把 AI 驯服，对外用软告警避免误伤。**

---

## 3. 为什么用 OpenClaw

### 3.1 直接原因：它是完整的 Agent 运行时，不是 SDK

`openclaw --help` 暴露的能力清单，基本决定了 Easel 的整个架构：

| 能力 | 命令 | Easel 怎么用 |
|---|---|---|
| 常驻 Gateway（WebSocket + HTTP） | `gateway` | 承载全部对话，端口 37289 |
| Agent turn 调度 | `agent` | `easel skill` 的实际执行路径 |
| Skill 加载 | `skills` | 114 个 SKILL.md 的运行环境 |
| 会话管理 | `sessions` / `resume` | 多轮对话与断线续接 |
| 记忆索引与检索 | `memory` | 画像长期记忆（Easel 改用文件承载） |
| 问答题 / 审批 | `approvals` | `ask_user` 卡片（`gateway_questions.py`） |
| 浏览器 | `browser` | 平台发布自动化 |
| MCP | `mcp` | 外部工具接入 |
| Cron / automations | `cron` | 定时发布 |
| 供应商抽象 | `models` / `infer` | 一份配置换任意模型 |
| Profile 隔离 | `--profile` | `~/.openclaw-easel/`，不污染用户已有配置 |

**如果自己写，这 11 块能力每块都是几周到几个月的工程。** OpenClaw 把它压缩成一次 `npm i -g openclaw@latest`。
这才是"为什么是 OpenClaw"的根本答案：**它把 Agent 基础设施的边际成本降到接近零，
让团队的全部精力可以投在 114 个 Skill 这类真正有壁垒的领域知识上。**

### 3.2 更深层的原因：Skill 规范与生态复用

Easel 的 `SKILL.md` frontmatter（`name` + `description` + `layer`）与 Claude Code Agent Skills 规范**同构**。
这意味着技能资产不是"Easel 私有的"，而是可以被别的 Agent harness 直接消费。
`docs/claude-agent-sdk-migration-plan.md:18,165` 明确把这点当作迁移可行性的关键依据。

### 3.3 代价：1500–2000 行胶水

选 OpenClaw 的代价非常具体地体现在代码里。Easel 自己的 Python 包只有 14 个文件、约 1945 行，
但 `web/app.py` 有 **4717 行、220KB**，里面大量是适配 OpenClaw quirks 的补丁：

- **端口哈希**：非默认 profile 不用 18789，而是 `20000 + fnv1a32(profile) % 40000` → easel = 37289
  （`gateway_endpoint.py:5-13,113-126`）
- **workspace 布局漂移**：2026.6.x 是 `~/.openclaw/workspace-easel`，2026.9.x 改成 `~/.openclaw-easel/workspace`。
  `openclaw_workspace.py:127-145` 写了**五级退化**去猜路径（env → 直接问 openclaw → openclaw.json →
  已有内容的候选 → 按版本猜）
- **流式靠 tail 共享文件**：gateway 把 token 写到 `/tmp/easel-raw-stream.jsonl`，后端用 `runId` 闩锁捞取
  （`web/app.py:2662-2736`）——不是 WebSocket，也不是 gateway 主动推送
- **传输层永不换边**：`/v1/chat/completions` 根本不读 `x-openclaw-session-id`，换边等于静默丢光历史
  （`web/app.py:2109-2135`）
- **Ed25519 设备配对桥**：`gateway_questions.py` 391 行，只为转发 `ask_user` 问答题
- **session-key 24h 空闲过期**、**inode 硬链接坑**（`sync.sh:93-103`，OpenClaw onboard 生成的 bootstrap 是硬链接，
  直接 `cp` 会写穿 inode 被拒，issue #26）

这些不是 bug，是**架构选型的必然账单**。

### 3.4 项目自己的态度：跟随上游，不打补丁

`docs/known-issues.md:15-39` 是很有说服力的一节：CLI 问答题重复显示的根因在上游 OpenClaw 的
session projection 逻辑，项目**复现并提交了上游 PR**（openclaw#144730、#144892），
然后在 `easel doctor` 里加最低版本检查（≥ 2026.6.11）——**不在自己仓库里内置补丁，而是跟随上游升级**。

同时 `README.md:377` 的 Roadmap 第 4 条写着：
> 适配更多 Agent Harness —— 支持 OpenClaw 之外的更多 Agent 运行框架，例如 Claude Code、DeepSeek harness、Codex 等

**结论：OpenClaw 是当前的实现载体，不是不可动摇的架构承诺。** 项目已经把 harness 抽象列进了 roadmap。

### 3.5 关于"迁移到 Claude Agent SDK"的计划 —— 需要澄清

仓库里有一份 `docs/claude-agent-sdk-migration-plan.md`（2026-10-01），主张用
**Claude Agent SDK 进程内嵌入 FastAPI 替换 OpenClaw gateway**，理由是删掉 1500–2000 行胶水、
114 个 SKILL 近乎零改写、前端与 SSE 协议一行不改。

> ⚠️ **重要澄清**：我用 `git ls-tree` 核对过——**这份文档既不在 `origin/main`，也不在 `fork/main`，
> 是本地未提交的草稿**（`git status` 显示为 `??`）。它是**一个提案**，不是已定的技术方向，更不是上游战略。

提案本身的取舍也很明确：一期**仅支持 Anthropic 协议**，OpenAI 兼容降级为可选 LiteLLM sidecar，
**Gemini CLI 免 key 能力直接放弃**。工期 4–7 周，关键路径是 Phase 0 的四点 PoC。

---

## 4. 设计理念：六条可提炼的原则

### ① 知识与运行时分离 —— Skill 是资产，Agent 是载体

114 个 SKILL.md 全部**平铺**在 `skills/openclaw/` 下，没有分类子目录。
五层工作流不是目录结构，而是 **frontmatter 里的 `layer:` 字段**（114/114 全覆盖）：

| layer | 数量 | 含义 |
|---|---|---|
| `produce` | 52 | 制作（图/文/音视频/小说/短剧） |
| `publish` | 20 | 发布（平台适配/登录/合规门禁） |
| `plan` | 16 | 策划（选题/脚本/排期） |
| `attribute` | 11 | 归因（数据/评论洞察/画像回流） |
| `discover` | 9 | 发现（热点/竞品/趋势） |
| `general` | 6 | 横切基础设施（画像/产物库/模板） |

`docs/SKILL-SPEC.md:13-25` 定义的解剖规范：**SKILL.md（<200 行，只写"怎么做"）+ references/（领域知识，按需加载）
+ scripts/（代码不进 prompt）+ tests/**。
另有 94 个技能附带 `EASEL-META.md`——记录所属层、来源类型、参考项目及许可、借鉴方式、对标物。
**把合规与溯源信息从 SKILL.md 卸载到常驻 prompt 之外**，是这个设计里很聪明的一笔。

> ⚠️ 小瑕疵：`docs/skill-function-mapping.md:8-15` 的分层计数是 51 个 produce、总计 113，
> 与实测 52 / 114 差 1，文档未同步。

### ② 提示词分层 —— 每层只管自己的事

`docs/prompt-stack.md` 定义了四层组合：

```
Layer 1: SOUL.md      人格 + 能力总览（常驻，2669B）
Layer 2: AGENTS.md    分工规则 + 编排逻辑 + Plan Mode（常驻，9595B）
Layer 3: CONTEXT.md   项目绝对路径（半静态，sync.sh 自动生成）
Layer 4: SKILL        触发时加载 SKILL.md + 按需读 references/
```

原则非常明确：**常驻层保持精简以控制 token，SKILL 层按需加载不用的不加载，references 只在执行时读。**

`SOUL.md` 只管人格——「像搭子一样自然，不端着」（`:26`）、「先想'怎么帮他做成'，而不是'这个我做不了'」（`:16`）、
一条对外红线「绝不暴露工具或配置痕迹」（`:29`），末尾把执行权交出去：
「先去技能库找对应的 SKILL 照着用，别凭记忆裸做」（`:18`）。

`AGENTS.md` 才是执行规约，六条核心规则里最有架构意义的是：

1. **先路由 SKILL** —— 每轮任务先找精确匹配的 SKILL，无匹配时才用通用能力（`AGENTS.md:7`）
2. **先到项目根** —— 跑第一个脚本前必须 `cd` 到运行时项目根，确认 `.env` 存在（`AGENTS.md:8`）
3. **不在 workspace 跑项目副本** —— 禁止从 workspace 或 SKILL 目录跑脚本（`AGENTS.md:9`）
4. **付费操作先确认** —— 生图/生视频/音乐等按量计费操作先给费用预估，等确认（`AGENTS.md:11`）
5. **真实产物才算完成** —— 不以计划、空壳文件、中途文件冒充成品（`AGENTS.md:12`）
6. **Plan Mode 触发条件** —— 清晰单层任务直接执行；跨两层以上先给简短 Plan（`AGENTS.md:41`）

规则 4 特别值得学习：**把"花钱"当成一个需要显式授权的操作**，而不是默认执行。
在一个按量计费的媒体模型密集型产品里，这是对的。

### ③ 画像驱动，而不是一次性生成

一个画像 = `profiles/<名字>/` 目录，六个维度：定位、风格、受众、平台、偏好与红线、长期记忆。
同一画像可跨多个平台和会话使用。

**关键设计：画像不落全局文件，而是作为消息前缀内联。**
`easel/persona.py:58-69` 的 `persona_prefix()` 只返回一句：

> 我当前使用的画像是「X」。本会话的账号长期记忆仅使用 profiles/X/memory.md，不要使用工作区全局 MEMORY.md

原因写得很直白：**并发竞态**。CLI 历史上写全局 `USER.md`，两个不同画像的会话会互相污染。
内联后每个请求自包含。代价是超长会话被压缩后可能丢画像（`easel/cli.py:69-71` 自述此取舍）。

配套的 `TURN_REMINDER`（`persona.py:77-83`）每轮在**消息末尾**重申"先查技能库"，
**对抗长对话中的指令衰减**——这是一个很实际的工程 trick。

### ④ 跨层编排靠"薄索引"而不是"传大对象"

`SKILL-SPEC.md:136-159` 定义 `manifest.py` 契约：上游 `record --layer plan` 登记，
下游 `latest --layer plan` 取用。`AGENTS.md:45` 要求跨两层以上时传**"产物路径 + 一句结论"**，
不重新推导也不整块转发；完整载荷写文件，关键决策写 `brief.md`；失败从断点续跑。

> **这是多 Agent 系统最容易被做错的地方。** 传文件路径 + 结论，而不是传大段内容——
> 既省 token，又让每一层的产物可独立检查，也让断点续跑成为可能。

### ⑤ 可观测性优先：宁可丑，不要静默

CHANGELOG 和代码里反复出现的模式是"失败要留痕"：

- 每轮对话同时 append 到 per-turn jsonl（`web/app.py:2396-2407`）
- 断线不杀任务：supervisor 与 forward 分离，agent 照常跑完并落盘（`web/app.py:2378-2386,2888-2904`），
  因为长任务常被 Web IDE 代理掐断
- 会话双层锁：`asyncio.Lock` 挡进程内并发，`fcntl.flock` 挡跨进程/多标签（`app.py:2167-2197`）
- `easel doctor` 会校验主模型 provider **真的**有凭据——修的就是"doctor 全绿但实际没有 provider"的假绿问题

`content_guard.py` 的 BLOCK/WARN 两级闸门也是同一个哲学的延伸。

### ⑥ 把"真实产物"当成交付标准

`AGENTS.md:12` 写死：**不以计划、空壳文件、中途文件或仅有提示词冒充成品；交付前必须自检。**
配合 `card_audit.py` 这样的确定性门禁（FAIL 必须重渲），
形成"模型产出 → 确定性脚本验收 → 不过就重做"的闭环。

**这是把传统软件工程的 CI 纪律搬到了 AI 产出上**，比"相信模型"靠谱得多。

---

## 5. 一条完整请求的运行时链路

```text
1. 用户在 Web 输入，前端 streamChat() POST /api/chat/stream
   └─ web/frontend/src/lib/api.ts:691-696，手写 SSE 解析器分派
      token / thinking / activity / question / heartbeat / error / done

2. 后端拼消息 chat_turn_message() = 画像前缀 + 附件清单 + 用户原文 + TURN_REMINDER
   └─ web/app.py:2061-2068 + easel/persona.py:91-99

3. 双层会话锁：asyncio.Lock（进程内）+ fcntl.flock（跨进程/多标签）
   └─ app.py:2078-2083, 2167-2197

4. 传输层判定 _resolve_transport() —— 同一会话永不换边
   └─ app.py:2109-2135

5a. HTTP 路径（默认，快约 3s/轮）：httpx POST /v1/chat/completions 到常驻 gateway
    └─ app.py:2419-2471
5b. CLI 路径：subprocess.Popen(openclaw agent …)
    └─ app.py:2500-2546

6. ★ OpenClaw 在此调用 LLM ★
   gateway 读 AGENTS.md → 路由到匹配的 SKILL.md → 调 skills/shared/scripts/*.py

7. 流式回传：gateway 写 /tmp/easel-raw-stream.jsonl → 后端按 runId 闩锁 tail
   └─ app.py:2662-2736；HTTP 模式下丢弃 text_delta 只取 thinking_delta 防重复

8. 前端：token/thinking 逐字流式显示，问答题渲染成卡片

9. 产物落盘：agent 写 outputs/（symlink 回项目根）→ 每轮结果存
   outputs/_sessions/<key>.json

10. 内容库：/api/outputs 拉目录树 + /api/media/{path} FileResponse 出二进制
    └─ app.py:3061-3160；删除受 "_" 前缀保护
```

**旁路：断线恢复。** 每轮结果落盘后，前端重连（预算 130 分钟，`api.ts:714-721`）可从
`/api/chat/last` 或 `/api/chat/jobs/{turn_id}/stream` 取回，不会丢结果。

---

## 6. 成本与风险清单

| 项 | 数据 | 评价 |
|---|---|---|
| 胶水层 | `web/app.py` 4717 行 / 220KB 单文件 | **最大技术债**，发布/登录/数据三块约 1900 行只读了路由签名 |
| 运行时耦合 | 1500–2000 行适配 OpenClaw quirks | 有明确的自救提案（见 3.5） |
| 技能维护 | 114 个 SKILL + 94 个 EASEL-META | 人力密集，LLM 改写一次知识成本高 |
| 文档漂移 | skill-function-mapping.md 计数 113 vs 实测 114 | 需定期校验（已有 `validate_skills.py`） |
| 未实测 provider | `ai_music.py` docstring 自述"未用真实 key 实测" | 能力可用性存疑 |
| 平台风控 | 小红书可能检测自动化，有验证/限流风险 | README 明确建议预览 + 人工确认发布 |
| 安全边界 | Web API CORS 开放且无鉴权 | 已加 CSP `connect-src 'none'` 封堵；本地工具定位 |
| 硬链接坑 | OpenClaw onboard 生成的 md 是硬链接，`cp` 会写穿 inode | `sync.sh:93-103` 用 `nlink` 检查规避 |

---

## 7. 给你的三条判断

1. **学它的"知识工程"，不要学它的"胶水"。**
   114 个 SKILL 的分层解剖、`EASEL-META.md` 溯源、`manifest.py` 薄索引、去 AI 感双门——
   这些是可直接迁移到任何项目的资产。而 4717 行的 `web/app.py` 是特定运行时绑定的历史包袱。

2. **"薄壳 + 厚知识库"是内容类 AI 产品的正确形态。**
   底层模型能力和 Agent 框架会持续商品化，**能积累复利的是领域知识**。
   Easel 把 90% 的工程量投在 skills 和 profiles 上，这个比例是对的。

3. **OpenClaw 是当前最优解但不是永久承诺。**
   它把 Agent 基础设施的边际成本压到接近零，代价是 1500–2000 行适配代码。
   项目自己已经在 roadmap 里把 harness 抽象列出来了，**并且关键资产（SKILL 规范、React 前端、媒体脚本）
   与 OpenClaw 几乎零耦合**——这说明当初选 OpenClaw 时就按"可换"来设计的。这一点做得很好。
