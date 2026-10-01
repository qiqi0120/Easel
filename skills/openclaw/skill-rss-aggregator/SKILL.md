---
name: skill-rss-aggregator
description: >-
  RSS/Newsletter 聚合：订阅一批博主/媒体/Newsletter 的 RSS/Atom 源，拉取最新条目，
  按关键词与时间窗过滤、去重、按时间排序，产出选题/资讯摘要。当用户说"RSS""订阅源"
  "聚合资讯""追更博主""Newsletter""看看最近有什么新文章""汇总这些源的更新""feed"时使用。
  纯标准库解析，无第三方依赖。
layer: discover
---

# RSS / Newsletter 聚合

> 把一批订阅源的最新更新聚合成摘要，用于每日选题与资讯追踪。走 `scripts/rss_digest.py`
> （纯标准库解析 RSS 2.0 / Atom），无第三方依赖。

> 全网热搜见 skill-trending-topics；行业新闻见 skill-news-intelligence；本 SKILL 专注
> **用户自选订阅源**的更新聚合。

## 输入

| 字段 | 必填 | 说明 |
|------|------|------|
| 订阅源 | 是 | `--url` 单个/多个，或 `--feeds` 列表文件（每行一个 RSS/Atom URL） |
| 关键词 | 可选 | 只保留标题/摘要命中的条目（逗号分隔） |
| 时间窗 | 可选 | 只保留最近 N 天 |

**默认订阅源（Web「我的关注」列表）**：用户没给订阅源、只说"看看我关注的博主 / 我订阅的更新"时，
先读 `outputs/_watchlist.json`（数组，取 `enabled=true` 条目的 `feed_url`，`name` 作展示名），
把这些 URL 当 `--url` 逐个传入；该文件不存在或为空才向用户要源。
这份列表与 Web 热点雷达「我的关注」分区共用，不要改写它，只读取。

> **例外——抖音条目**：`platform == "douyin"` 的条目不走 RSS（抖音 WAF 拦无 Cookie 抓取），
> 改用登录态抓取：`python skills/shared/scripts/douyin_watch.py fetch --uid <条目uid> --limit 10`。
> uid 字段为空时从 feed_url 里反解（`douyin.com/user/<sec_uid>`）。脚本 exit 8 表示抖音未登录，
> 引导用户先在 Web「账号」页登录。

## 执行

脚本路径（相对项目根）：`skills/openclaw/skill-rss-aggregator/scripts/rss_digest.py`。

```bash
# 聚合多源，过滤 AI/大模型，最近 7 天，输出 Markdown 摘要
python <skill>/scripts/rss_digest.py fetch --feeds feeds.txt \
  --keyword AI,大模型,Agent --since 7 -o outputs/资讯简报/digest.md

# 单个源快速看
python <skill>/scripts/rss_digest.py fetch --url https://example.com/feed.xml --limit 20
```

`feeds.txt` 每行一个 URL（`#` 开头为注释）。输出 `.md` 自动 Markdown，否则 JSON。

## 结果怎么用

1. 聚合摘要 → 从中挑选题，喂 skill-topic-evaluator 评估可行性、skill-content-matrix 排选题。
2. 关键词过滤锁定垂类，只看和账号相关的更新。
3. 定期跑（配合 OpenClaw 定时）做"每日/每周资讯简报"。

## Profile 感知

- 有 Profile：默认关键词取 `identity.md` 垂类关键词；只推与账号定位相关的更新。
- 无 Profile：不过滤或按用户给的关键词，全量聚合。

## 规则

1. 找不到某平台 RSS 时，很多站点/公众号可用 RSSHub 生成 RSS，提示用户配置。
2. 无 pubDate 的条目不因时间窗被误删（保留，排最后）。
3. 摘要只列标题/来源/日期/摘要片段与链接，不抓全文（尊重版权）。
4. 拉取失败的源跳过并提示，不中断整体聚合。

## 参考来源

RSS 2.0 / Atom 为标准 XML 订阅格式；无 RSS 的站点常用 RSSHub 生成。本 SKILL 用 stdlib
xml.etree 解析（兼容两种格式 + HTML 清洗 + RFC822/ISO 日期），关键词/时间窗过滤 + 去重排序。
