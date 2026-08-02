/**
 * Tier 1 折叠 —— 把折叠窗之外的工具结果 detail/preview 替换为短桩。
 *
 * S16（G63）起，折叠从「每轮重算的滑动窗」改为「持久水印」：
 * - computeFoldWatermark(history)：整理时刻算出水印应前移到的消息 id（当前折叠窗边界）。
 * - applyFoldingByWatermark(history, id)：回合装配按固定水印折叠——水印之前的工具回执成占位，
 *   水印及之后原样。水印在两次整理之间不动，折叠前缀逐字节稳定、不每轮碎 prompt cache。
 * 水印落 Conversation.foldedBeforeMessageId（纯视图参数、不进 UI 回放）；语义与推进时机见
 * docs/tech/2026-07-11-s16-backend续发钩子与整理时机实施方案.md §3.4/§5。
 *
 * 白名单 kind 从 compress.ts 复用——见 NEVER_COMPRESS_KINDS export。
 */
import type { ChatMessage, ToolCall } from '@shared/types';
import { normalizeToolName } from '@shared/agent/toolName';
import { NEVER_COMPRESS_KINDS } from './compress';
import { readFileHint } from './persist';

/** 未落盘的折叠桩：原文取不回，只能重新调用（web_fetch 等落过盘的走带路径桩）。 */
const FOLD_STUB = '[早期结果已折叠，需要原文请重新调用]';
/**
 * 按工具豁免折叠：ask_user_choice 的回答是用户亲笔内容，折叠桩的「重新调用」＝把答过的
 * 问题再问用户一遍，不可再生；且回答通常短（点选不过线）、长即重要。豁免后待遇与用户
 * 打字的 user 消息对齐——折叠层永不碰，仅随 Tier 2 整段摘要（compress.ts）。
 * 名字先归一再比对——claude-code 后端落盘的 ToolCall.name 带 mcp__oru__ 前缀。
 * ask_twin（子 agent 问主脑，同为用户亲笔回流）是同类，但子 agent 历史今天不走本折叠
 * 管线（全仓只有主对话 runner 调 applyFoldingByWatermark）——若将来接入，需同步豁免。
 */
const NEVER_FOLD_TOOLS = new Set(['ask_user_choice']);
/**
 * 折叠值不值当门槛——小结果不折（省下来无几，还白碎一次 prompt cache）。纯性能考量，
 * 不负责正确性：「折叠必缩短」由 foldToolCall 末尾对桩长的直接比较兜住（落盘桩带无界路径，
 * 固定门槛按定义兜不住）。
 */
const MIN_FOLD_BYTES = 150;
/** 折叠窗：保留最近 N 轮 user 原文不折。N=3 是 atomcode 验证过的甜点。 */
const KEEP_RECENT_ROUNDS = 3;

/**
 * 整理时刻水印应前移到的消息 id——当前折叠窗（最近 KEEP_RECENT_ROUNDS 轮 user）的起点。
 * 该消息「之前」的工具回执可折；该消息及之后属折叠窗、保原文。
 * user 轮数不足折叠窗 → 无可折内容，返回 undefined（调用方据此清空水印）。
 */
export function computeFoldWatermark(history: ChatMessage[]): string | undefined {
  const userIdxs: number[] = [];
  for (let i = 0; i < history.length; i += 1) {
    if (history[i].role === 'user') userIdxs.push(i);
  }
  if (userIdxs.length <= KEEP_RECENT_ROUNDS) return undefined;
  const foldUntilIdx = userIdxs[userIdxs.length - KEEP_RECENT_ROUNDS];
  return history[foldUntilIdx].id;
}

/**
 * 按持久水印折叠：水印所指消息「之前」的工具回执折成占位，水印及之后原样。
 * watermarkId 为 undefined、或不在当前视图中（被动整理递减吞过折叠窗等）→ 视为无水印、不折，
 * 引用原样返回；下次整理由 computeFoldWatermark 重新钉。
 */
export function applyFoldingByWatermark(
  history: ChatMessage[],
  watermarkId: string | undefined,
): ChatMessage[] {
  if (!watermarkId) return history;
  const foldUntilIdx = history.findIndex((m) => m.id === watermarkId);
  if (foldUntilIdx < 0) return history; // 水印不在视图 → 视为无水印

  return history.map((msg, idx) => {
    if (idx >= foldUntilIdx) return msg;
    if (msg.kind && NEVER_COMPRESS_KINDS.has(msg.kind)) return msg;
    if (!msg.toolCalls || msg.toolCalls.length === 0) return msg;
    return foldMessage(msg);
  });
}

function foldMessage(msg: ChatMessage): ChatMessage {
  // .map() 永远返回新数组——用显式 folded 标志判断是否真有折叠发生
  // 没真折叠就返回原 msg，避免无意义的 shallow clone
  let folded = false;
  const newToolCalls = msg.toolCalls.map((tc) => {
    const next = foldToolCall(tc);
    if (next !== tc) folded = true;
    return next;
  });
  if (!folded) return msg;
  return { ...msg, toolCalls: newToolCalls };
}

function foldToolCall(tc: ToolCall): ToolCall {
  if (!tc.result) return tc;
  if (NEVER_FOLD_TOOLS.has(normalizeToolName(tc.name))) return tc;
  const persisted = tc.result.persistedRef;
  // historyAdapter 选 tool_result 内容时是"persistedRef.preview 优先，否则 detail"——
  // 两者发给 LLM 是二选一关系，不是相加。用 max 比较"实际发给 LLM 的体积"才对。
  const currentContentSize = Math.max(
    persisted?.preview.length ?? 0,
    tc.result.detail?.length ?? 0,
  );
  if (currentContentSize < MIN_FOLD_BYTES) return tc;

  // G65：落过盘的桩带路径「随时可读回」，没落盘的走原桩「取不回、重新调用」。
  const stub = persisted
    ? `[早期结果已折叠；全文 ${persisted.totalChars} 字符已落盘，${readFileHint(persisted.path)}]`
    : FOLD_STUB;
  // 折叠必缩短：路径无界，落盘结果极短时带路径桩可能反而更长——直接比对，不缩短就不折
  // （桩是消息的确定性函数，此判断对同一消息稳定，S16 水印重建逐字节不受影响）。
  if (stub.length >= currentContentSize) return tc;

  return {
    ...tc,
    result: {
      ...tc.result,
      detail: stub,
      persistedRef: persisted ? { ...persisted, preview: stub } : undefined,
    },
  };
}
