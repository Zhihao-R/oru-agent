/**
 * 工具结构化数据的"桥"——把工具 execute 算好的 ToolResult.structured 送到 stream.ts。
 *
 * 为什么需要：claude-code 后端下，工具的 ToolResult.structured **不流经** stream.ts——
 * buildToolsMcpServer 的 MCP 包装器只把 text + images 塞进 MCP content，structured 在该路径丢弃
 * （见 backends/claudeCode.ts）。anthropic / openai 后端原生透传 structured，不需要这座桥。
 * 与 toolVisuals.ts 同构（那座桥解决的是 images/visual 的同一个 MCP 缺口）。
 *
 * 关联键用 (conversationId, name, 入参快照)——execute 在 MCP 闭包里拿不到 SDK 的 tool_use id。
 * execute 必在对应 tool_result 事件之前完成，故 stash 先于 take，无竞态。take 即删；同键重复覆盖。
 * 非 claude-code 后端 stream.ts 优先用 ev.structured、不 take，残留靠 FIFO 上限兜底。
 */
const store = new Map<string, Record<string, unknown>>();
const MAX_ENTRIES = 128;

function keyOf(conversationId: string, name: string, input: unknown): string {
  let inputKey: string;
  try {
    inputKey = JSON.stringify(input ?? {});
  } catch {
    inputKey = String(input);
  }
  return `${conversationId} ${name} ${inputKey}`;
}

export function stashToolStructured(
  conversationId: string,
  name: string,
  input: unknown,
  structured: Record<string, unknown>,
): void {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(keyOf(conversationId, name, input), structured);
}

/** 取出并删除（消费一次）。无匹配返回 undefined。 */
export function takeToolStructured(
  conversationId: string,
  name: string,
  input: unknown,
): Record<string, unknown> | undefined {
  const k = keyOf(conversationId, name, input);
  const v = store.get(k);
  if (v !== undefined) store.delete(k);
  return v;
}

/** 仅测试用 */
export function __clearToolStructuredForTest(): void {
  store.clear();
}
