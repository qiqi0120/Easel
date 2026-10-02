# AGENTS.md — Easel 工作区指南

Easel（界面品牌名 Atelier）：社媒内容工作流工作台。**Easel 本身不调 LLM**——它是"薄壳 + 厚知识库"：
领域知识（114 个 SKILL）+ 用户画像 + 交付界面；LLM 调用、会话、工具调度都在 OpenClaw gateway（常驻，端口 37289）里。
先读 `docs/architecture-analysis.md` 可获得完整分层图景。

## 目录结构

- `easel/` — Python 包：CLI（`easel chat/web/doctor/gateway/ping/skill`）、gateway 桥接（SSE/WS/问答题）
- `web/app.py` — **单文件 FastAPI 后端（约 4700 行）**：全部 API、编排、缓存都在这一个文件里，按注释分节
- `web/frontend/` — React 19 + Vite + TS；`npm run build` 产出 `web/frontend/dist`（后端优先服务它，缺失回落 `web/static/`）
- `skills/openclaw/` — SKILL 目录（发现/策划/制作/发布/归因五层），由 OpenClaw agent 执行
- `skills/shared/scripts/` — ~50 个确定性 Python 工具（douyin_watch、rss_digest、媒体处理等），多为独立 CLI
- `profiles/` — 账号画像（六维上下文）；`outputs/` — 产物与系统状态；`openclaw/` — gateway 配置与 workspace（`sync.sh` 把 `outputs/` 软链进去）

## 常用命令

```bash
# Python（优先项目 .venv，playwright 只装在这里；Web 服务可能被系统 Python 拉起）
source .venv/bin/activate
python -m pytest tests/ -x              # pytest.ini 只加了 --import-mode=importlib
python -m easel web                     # uvicorn :7860（EASEL_PORT 可改）
# 抓取脚本自带离线自检：
python skills/shared/scripts/douyin_watch.py selftest

cd web/frontend
npm run dev        # vite 开发服务器
npm run build      # tsc -b && vite build（类型检查即构建）
npm run lint       # oxlint
```

## 架构边界（改动前必看）

- **产物走文件系统，不走 API**：agent 写 `outputs/`（经软链），前端经 `/api/outputs` + `/api/media` 呈现。`outputs/` 下 `_` 前缀是系统状态文件（`web/app.py` 的 `PROTECTED_OUTPUTS`：`_login`、`_schedule.json`、`_watchlist.json` 等），有删除保护，别动用户项目目录。
- **编排层 = web/app.py**：拼消息（画像前缀 + 附件 + TURN_REMINDER）→ gateway；对话用 SSE 流式。新 API 跟着对应分节写，注意既有缓存模式（如 `WATCHLIST_CACHE_TTL=300s`、失败回落旧值）。
- **登录态抓取**（douyin_watch.py / bili_login.py）：用 `~/.easel-browser-profiles/` 持久化 Playwright profile，旁听页面自己的 XHR。子进程必须用项目 .venv 的解释器（见 app.py `_script_python()`），否则 playwright 缺失静默失败。
- **抖音翻页限制**：a_bogus 签名在页面里算，无法自己构造第 N 页请求，只能真实滚动让页面发下一页 XHR；深度加载靠 `--want N --seen-file`（增量按 aweme_id 集合记水位，不按页码）。
- **代理约束**：国内平台（抖音等）必须直连（`--no-proxy-server`）；海外请求走 `EASEL_PROXY`。
- **SKILL 规范**：改 skills/ 前读 `docs/SKILL-SPEC.md` —— SKILL.md < 200 行只写"怎么做"，领域知识进 `references/`，可执行代码进 `scripts/`。

## 约定

- 注释与 commit message 均为中文；commit 用 conventional 前缀 + 中文描述（如 `feat(web): 热点雷达接入抖音`）。注释密度高、专讲"为什么/约束"，新代码照此风格。
- 前端无组件库，用既有 class（`btn`、`chip`、`card`、`trend-*`）；页面级缓存模式见 `TrendsPage.tsx` 顶部注释（sessionStorage、12h 过期、切 tab 不重拉）。
- 平台时间统一东八区；面向国内的展示文案用中文。
- 相关文档：`docs/known-issues.md`（终端显示问题）、`docs/claude-agent-sdk-migration-plan.md`（评审稿，尚未实施）。
