/**
 * 对话级搜索预算（硬闸门）——PRD §搜索预算硬上限 100 的代码兜底。
 *
 * 仅靠 system prompt 自律不可靠；这里保证无论模型怎么"冲"都最多调 100 次。
 * runner 在用户每条新消息进入时调 resetConversationBudget；
 * web_search/web_fetch.execute 顶部调 consumeBudget——返回 false 即超额。
 */

const MAX_CALLS_PER_TURN = 100;

const counters = new Map<string, number>();

export function resetConversationBudget(conversationId: string): void {
  counters.set(conversationId, 0);
}

/**
 * 消费一次预算。返回 false 表示已超额，调用方应直接 isError 退化。
 * 计数仅在成功消费时 +1（false 时不动，让超额错误能稳定可重现）。
 */
export function consumeBudget(conversationId: string): boolean {
  const cur = counters.get(conversationId) ?? 0;
  if (cur >= MAX_CALLS_PER_TURN) return false;
  counters.set(conversationId, cur + 1);
  return true;
}

export function getCurrentBudget(conversationId: string): number {
  return counters.get(conversationId) ?? 0;
}

/**
 * 对话彻底结束时调——从 Map 删 entry，避免一次性 conversationId（背景 query / 子 agent task）泄漏。
 *
 * 主对话 conversation id 会持续被新消息 reset 复用，所以**主对话路径不要**调这个；
 * 只在 bg_*_<timestamp> / task_<taskId> 这种一次性 id 跑完后调。
 */
export function finalizeConversationBudget(conversationId: string): void {
  counters.delete(conversationId);
}

/** 仅测试用 */
export function getBudgetMapSizeForTest(): number {
  return counters.size;
}

export function getMaxBudget(): number {
  return MAX_CALLS_PER_TURN;
}

/** 仅测试用 */
export function __resetBudgetMapForTest(): void {
  counters.clear();
}
