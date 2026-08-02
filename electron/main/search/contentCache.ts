/**
 * 搜索正文预存缓存（AnySearch 接入·批 3）——进程内、按 URL。
 *
 * 搜索响应顺带的正文不进模型上下文（摘要漏斗不变），进这里：模型决定 web_fetch 某条
 * URL 时命中即省一次网络抓取。定位是提速不是提质（实测 AnySearch 抽取不比本地 turndown
 * 管线干净），穿透条件宁可保守——只有 complete 的条目才被消费。
 *
 * TTL 15 分钟（搜索到抓取通常在同一轮对话内）；容量 100 条 LRU（按 4000 字/条估算峰值
 * 约 800KB，内存无关紧要，给界只为防长会话无限涨）。
 *
 * 随删条款：当前唯一写入方是带 content 的引擎（AnySearch）——删除它后本机制零写入、
 * 永不命中；届时若无其他带正文引擎，本模块与测试随删，不留空转机制。
 */

export type CachedContent = {
  text: string;
  title: string;
  /** 适配器判定的完整性——false（疑似截断）的条目 web_fetch 不消费、照常真抓 */
  complete: boolean;
};

type Entry = CachedContent & { at: number };

const TTL_MS = 15 * 60 * 1000;
const MAX_ENTRIES = 100;

// LRU 靠 Map 插入序表达：读写都 delete+set 挪到末尾（key 重用时裸 set 不移位，见
// feedback_map_order_unreliable_for_recency），淘汰取首个 key。
const cache = new Map<string, Entry>();

export function putContent(url: string, content: CachedContent): void {
  cache.delete(url);
  cache.set(url, { ...content, at: Date.now() });
  if (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

export function getContent(url: string): CachedContent | undefined {
  const e = cache.get(url);
  if (!e) return undefined;
  if (Date.now() - e.at > TTL_MS) {
    cache.delete(url);
    return undefined;
  }
  // 命中刷新热度（真 LRU），at 不变——TTL 以写入时刻计，不因读续命
  cache.delete(url);
  cache.set(url, e);
  return { text: e.text, title: e.title, complete: e.complete };
}

/** 仅测试用 */
export function __clearContentCacheForTest(): void {
  cache.clear();
}
