# 设计：视频热点「做内容」自动转写视频文字

日期：2026-10-02
状态：已定案（自主模式下按仓库既有约定决策，未经逐条确认）

## 背景与目标

热点雷达「做内容」按钮目前只把**标题**传进对话（`App.tsx handleUseTopic` 拼
`围绕当前热点「标题」…` 后走 `/api/chat/stream`）。内容源是抖音视频时，agent
看不到视频里实际说了什么，二创只能凭标题猜。

目标：
1. 点「做内容」且内容源是**抖音视频**时，用**本地模型**（faster-whisper，走既有
   `skills/shared/scripts/asr.py`）把视频语音转成文字，连同标题一起交给下一阶段。
2. **不重复转写**：按 aweme_id 落盘缓存，命中直接复用；失败的条目 24h 内也不重试
   （避免图文帖/风控条目每次点击都白跑一次浏览器）。

## 备选方案与取舍

- **A. 薄壳内确定性转写（选定）**：点按钮 → 前端调 `POST /api/transcribe` → 后端
  登录态下载视频 + 本地 ASR → 缓存 → 前端把转写文本拼进 prompt 再发。
  与架构一致（确定性工具在 shell、产物/状态走文件系统、agent 只收文本）；进度可见、
  缓存可控；失败可静默回落「仅标题」。
- B. 把视频 URL 丢给 agent，由 OpenClaw 现场跑 auto-subtitle SKILL：非确定性、
  每轮多一次 agent 调度开销、缓存散落在 agent 侧、用户无法在 UI 上看到转写进度。否决。
- C. 拉取热点/收藏时后台预转写全部条目：绝大多数条目永远不被「做内容」，浪费且
  与 douyin 浏览器抓取抢资源。否决（YAGNI）。

## 链路设计

```
TrendRow「做内容」(blog/collect 行，带 it.url)
  → TrendsPage.useTopic(title, url)      // 忙态标记，按钮显示「转写中…」
  → App.handleUseTopic(title, videoUrl)
      ├─ videoUrl 是抖音视频 → POST /api/transcribe {url}
      │    后端：_transcript_read 缓存命中 → 直接返回
      │    未命中：加全局锁 → douyin_watch.py download（登录态旁听 detail XHR
      │    拿 play_addr，ctx.request 共享 cookie 下载）→ 时长上限校验（15 分钟）
      │    → asr.py transcribe --format txt（本地 faster-whisper base，模型缓存在
      │    ~/.cache/easel-models）→ 结果写 outputs/_transcripts/<aweme_id>.json
      ├─ ok：prompt 追加「原视频的文字转写」块（含时长、转写文件路径供 agent 回读全文）
      └─ 失败：静默回落，与现状完全一致（仅标题）
  → createSession + sendUserAndStream（跳对话页，prompt 里带转写）
```

## 关键决策

| 决策点 | 选择 | 理由 |
|---|---|---|
| 转写触发 | 点「做内容」时懒转写（sync HTTP，前端按钮忙态） | 单用户本地工具； Typical 1-2 分钟视频全程 ≈20-60s；缓存后二次点击 0 开销 |
| 下载方式 | `douyin_watch.py` 新增 `download` 子命令 | 复用持久化登录 profile、LAUNCH_ARGS、登录检查、退出码约定；页面自己的 detail XHR 自带合法签名 |
| 下载通道 | 旁听 `/aweme/v1/web/aweme/detail/` 响应取 `play_addr.url_list`，`ctx.request.get()` 下载（与页面共享 cookie） | 不自己构造签名请求；detail XHR 是页面加载必发的 |
| ASR | `asr.py transcribe --format txt`（默认 base/int8，语言 auto） | 仓库既有确定性封装，零新依赖；txt 正好是喂 LLM 的形态 |
| 缓存 | `outputs/_transcripts/<aweme_id>.json`，成功永久有效，失败记 error + 24h TTL | `_` 前缀天然受删除保护且不进内容库（`_is_protected`/`get_output_tree` 现成覆盖）；原子写（tmp+replace）沿 `_deep_write` 模式 |
| 并发 | 全局 `threading.Lock` + 双检缓存 | 转写要起浏览器+whisper，串行防资源踩踏（同 `_DEEP_RUN_LOCK` 理由）；等锁后先查缓存防并发重复转写 |
| 时长上限 | 15 分钟，超出报错并按失败缓存 | 控制 ASR 子进程耗时上限（base int8 ≈ 3x 实时内），也控制同步请求上限 |
| 适用范围 | 仅 `douyin.com/video/<id>` 条目（关注博主/我的收藏）；热搜榜与 RSS 条目维持仅标题 | B 站/小红书等 RSS 源下载通道未建，不做（YAGNI） |
| 图文帖 | detail 无 play_addr → 报「图文/无音轨」，按失败缓存 24h，前端静默回落 | douyin_watch 现未区分 aweme_type，靠失败缓存兜底，不改抓取 schema |

## 改动清单

- `skills/shared/scripts/douyin_watch.py`：新增 `download` 子命令（`_pick_play_url`
  纯函数进 selftest）；退出码 5=图文无音轨、6=超时未截到、7=下载失败、8=未登录。
- `web/app.py`：`/api/transcribe` + `_transcript_read/_transcript_write/
  _transcribe_douyin`（watchlist 分节后新增「视频文字转写」小节）。
- `web/frontend/src/lib/api.ts`：`ensureTranscript()`、`isDouyinVideoUrl()`。
- `web/frontend/src/App.tsx`：`handleUseTopic(title, videoUrl?)` 异步化，转写块拼 prompt。
- `web/frontend/src/components/TrendsPage.tsx`：`onUseTopic` 签名加 url；忙态标记。
- `web/frontend/src/components/trends/TrendRow.tsx`：`busy` 态按钮文案。
- `tests/test_transcribe.py`：缓存读写/失败 TTL/双检/非抖音 400（monkeypatch 执行体，
  不起真浏览器）。

## 错误处理

全链路失败均**不阻断创作**：接口返回 200 + `{ok:false,error}`（沿收藏面板
「200+error 字段不算请求失败」的既有约定），前端回落仅标题。仅非法链接返回 400。
