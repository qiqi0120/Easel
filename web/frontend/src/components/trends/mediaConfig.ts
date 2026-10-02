// 热点雷达的媒体能力矩阵：哪些媒体有哪些数据源。
// 与后端保持一致，改这里前先确认 web/app.py 的 TREND_SOURCES / _RSS_ROUTES。

export type MediaKey =
  | 'douyin' | 'weibo' | 'bilibili' | 'xiaohongshu'
  | 'zhihu' | 'toutiao' | 'baidu' | 'other';

export type SourceKey = 'hot' | 'blog' | 'collect';

export interface MediaDef {
  key: MediaKey;
  label: string;
  /** 热搜聚合源（web/app.py TREND_SOURCES 里 key 存在即有） */
  hot: boolean;
  /** 可订阅博主：RSSHub 自动路由的平台，或「其他」手填 RSS */
  blog: boolean;
  /** 登录态拉本账号收藏，目前只有抖音（/api/watchlist/collect） */
  collect: boolean;
  /** 视觉上与主媒体分隔（手填源堆在末尾） */
  trailing?: boolean;
}

export const MEDIA: MediaDef[] = [
  { key: 'douyin', label: '抖音', hot: true, blog: true, collect: true },
  { key: 'weibo', label: '微博', hot: true, blog: false, collect: false },
  { key: 'bilibili', label: 'B站', hot: true, blog: true, collect: false },
  { key: 'xiaohongshu', label: '小红书', hot: false, blog: true, collect: false },
  { key: 'zhihu', label: '知乎', hot: true, blog: false, collect: false },
  { key: 'toutiao', label: '头条', hot: true, blog: false, collect: false },
  { key: 'baidu', label: '百度', hot: true, blog: false, collect: false },
  // 手填 RSS 的落点：不给它家就成了一堆看不见的孤儿订阅
  { key: 'other', label: '其他', hot: false, blog: true, collect: false, trailing: true },
];

export const DEFAULT_MEDIA: MediaKey = 'douyin';
export const ALL_BLOGGERS = '__all__';

export const SOURCE_LABEL: Record<SourceKey, string> = {
  hot: '热搜榜',
  blog: '关注博主',
  collect: '我的收藏',
};

// 博主订阅的落点：RSSHub 能自动生成路由的平台，或「其他」手填 RSS。
// 注意——管理弹窗的平台下拉一直只有这四个选项，所以所有手填源都落在 other，
// 微博/知乎/头条/百度 的 watchlist 条目并不存在，矩阵里也就不能标 blog: true。
export const BLOG_PLATFORMS: { key: MediaKey | 'other'; label: string; auto: boolean }[] = [
  { key: 'douyin', label: '抖音', auto: true },
  { key: 'bilibili', label: 'B站', auto: true },
  { key: 'xiaohongshu', label: '小红书', auto: true },
  { key: 'other', label: '其他（手填 RSS）', auto: false },
];

/** 该媒体是否在管理弹窗的平台下拉里有对应选项（有就预选它，没有就让用户走「其他」） */
export function blogPlatformFor(key: MediaKey): MediaKey | 'other' {
  return BLOG_PLATFORMS.some((p) => p.key === key) ? key : 'other';
}

const BY_KEY = new Map(MEDIA.map((m) => [m.key, m]));

export function mediaDef(key: MediaKey): MediaDef {
  return BY_KEY.get(key) ?? MEDIA[0];
}

/** 该媒体实际有的数据源，按固定顺序返回——不渲染空 tab */
export function sourcesOf(key: MediaKey): SourceKey[] {
  const m = mediaDef(key);
  const out: SourceKey[] = [];
  if (m.hot) out.push('hot');
  if (m.blog) out.push('blog');
  if (m.collect) out.push('collect');
  return out;
}

export function mediaLabel(key: string): string {
  return BY_KEY.get(key as MediaKey)?.label ?? key;
}

/** 名称哈希 → 画像头像用的六色（与 --persona-c1..c6 对齐），给博主头像上色 */
const AVATAR_COLORS = ['#0ea5e9', '#7c3aed', '#db2777', '#059669', '#d97706', '#64748b'];

export function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}
