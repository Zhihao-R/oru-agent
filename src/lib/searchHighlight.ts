/**
 * 搜索结果的关键词高亮 / 上下文切片（对话栏整理 2026-06-19）。
 * 全部产出「结构化段」而非 HTML 字符串——交给 React 渲染 <mark>，天然防注入，不手搓转义。
 * 大小写不敏感、只切第一处命中（一条命中一行，够用且干净）。
 */

export type HighlightSeg = { text: string; hit: boolean };

/** 把整段文本按查询词切成高亮段：hit=true 的段渲染 <mark>。用于标题这类要整段显示的场景。 */
export function splitHighlight(text: string, query: string): HighlightSeg[] {
  const q = query.trim();
  if (!q) return [{ text, hit: false }];
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return [{ text, hit: false }];
  const segs: HighlightSeg[] = [];
  if (i > 0) segs.push({ text: text.slice(0, i), hit: false });
  segs.push({ text: text.slice(i, i + q.length), hit: true });
  if (i + q.length < text.length) segs.push({ text: text.slice(i + q.length), hit: false });
  return segs;
}

/** 命中词前后各截一小段，两头按需 … 省略——长消息只给关键词附近，结果一行干净。 */
export type Snippet = {
  pre: string;
  hit: string;
  post: string;
  ellipsisStart: boolean;
  ellipsisEnd: boolean;
};

/**
 * 命中消息的上下文切片：关键词前 pre 字、后 post 字，两头超出则置省略标记。
 * 调用方只该对「确有命中」的消息用它；无命中时退化成截首段（hit 为空）。
 */
export function snippet(text: string, query: string, pre = 8, post = 22): Snippet {
  const q = query.trim();
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) {
    const head = text.slice(0, pre + post);
    return { pre: head, hit: '', post: '', ellipsisStart: false, ellipsisEnd: text.length > head.length };
  }
  const start = Math.max(0, i - pre);
  const end = Math.min(text.length, i + q.length + post);
  return {
    pre: text.slice(start, i),
    hit: text.slice(i, i + q.length),
    post: text.slice(i + q.length, end),
    ellipsisStart: start > 0,
    ellipsisEnd: end < text.length,
  };
}
