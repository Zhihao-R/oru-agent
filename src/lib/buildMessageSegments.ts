import type { ToolCall } from '@shared/types';

/**
 * assistant 回合的一个渲染段：要么一段文本，要么一簇相邻的工具调用。
 */
export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'tools'; tools: ToolCall[] };

/**
 * 把"拼平的 text + 工具列表"还原成按时序交错的渲染段。
 *
 * 每个工具调用携带 textOffset——它发生时前面已积累的文本字符数（后端 stream.ts 盖戳）。
 * 据此把 text 在偏移处切开，文本段与工具簇交替排列；相邻、同偏移的工具聚成一簇。
 *
 * 老数据的工具没有 textOffset → 回退到"工具置顶 + 整段文本"，与旧版渲染一致。
 */
export function buildMessageSegments(text: string, toolCalls: ToolCall[]): MessageSegment[] {
  if (toolCalls.length === 0) {
    return text ? [{ kind: 'text', text }] : [];
  }

  const hasOffsets = toolCalls.every((t) => typeof t.textOffset === 'number');
  if (!hasOffsets) {
    const segs: MessageSegment[] = [{ kind: 'tools', tools: toolCalls }];
    if (text) segs.push({ kind: 'text', text });
    return segs;
  }

  const ordered = [...toolCalls].sort((a, b) => a.textOffset! - b.textOffset!);
  const segments: MessageSegment[] = [];
  let cursor = 0;
  let cluster: ToolCall[] = [];
  let clusterOffset = -1;

  // 纯空白的切片不成段——避免在交错处插入看不见的空 markdown 块
  const flushText = (to: number) => {
    const slice = text.slice(cursor, to);
    if (slice.trim()) segments.push({ kind: 'text', text: slice });
    cursor = to;
  };

  for (const tc of ordered) {
    const offset = tc.textOffset!;
    if (cluster.length && offset !== clusterOffset) {
      segments.push({ kind: 'tools', tools: cluster });
      cluster = [];
    }
    if (cluster.length === 0) {
      flushText(offset);
      clusterOffset = offset;
    }
    cluster.push(tc);
  }
  if (cluster.length) segments.push({ kind: 'tools', tools: cluster });

  const tail = text.slice(cursor);
  if (tail.trim()) segments.push({ kind: 'text', text: tail });

  return segments;
}
