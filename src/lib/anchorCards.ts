/**
 * S1 回合内锚点：把带 anchorTo 的保留卡从顶层时间流抽出，插到所属回合的 assistant 回复之后。
 *
 * 病根（见 docs/plans/2026-08-02-s1-消息流时序修复-实施plan.md）：一个 AI 回合只产一条 assistant
 * 消息，它的 createdAt 被刻意盖成回合开始；而 memory-record / skill-call / plugin-activate 这类卡是
 * 独立顶层消息，createdAt 晚于回合开始 → 按 createdAt 排序后恒沉到该回合回复之后（视觉沉底、刷新
 * 救不回）。解法：卡上带 anchorTo:{messageId} 标记所属回合，渲染时插到该回合 assistant 回复旁。
 *
 * 降级语义：卡带 anchorTo 但匹配不到对应 assistant 消息（崩溃/被撤、重载时 assistant 未落盘等极端）
 * → 优雅降级留在顶层流按 createdAt 沉流尾（不丢卡），并计一条 dev 级计数——防"锚点逻辑坏了→大量
 * 卡静默沉底像老行为"掩盖真 bug。
 *
 * 纯函数（不依赖 React / store），便于直接单测。泛型 T 为时间线项类型（含折叠组/proposal 的判别联合）——
 * 调用方传入的整体类型原样透传（topItems 保留判别联合）；项内 data 段统一 unknown，本函数内部只对
 * message 卡以 Partial<ChatMessage> 收口读取。
 */
import type { ChatMessage } from '@shared/types';

/** 参与锚点的卡 kind（与 turnArgs 盖锚点的一侧同口径）：memory-record / skill-call / plugin-activate */
export const ANCHORED_CARD_KINDS = new Set(['memory-record', 'skill-call', 'plugin-activate']);

/**
 * 锚点匹配不到时的 dev 级降级计数。无既有 debug 面板接入点，先以导出计数变量承载
 * （debug 面板后续如需可视化可直接 import 读）；测试断言它增长即可。
 */
export const anchorCardMissCount = { value: 0 };

/** 任意时间线项的公共形状——调用方传入的折叠组 / proposal 判别联合原样透传（不强行统一 data 类型） */
export type TimelineItem = {
  kind: string;
  key: string;
  ts: number;
  data: unknown;
};

/**
 * 把"带 anchorTo 的卡"从顶层流抽出，按 messageId 映射到对应 assistant 消息。
 *
 * - 卡带 anchorTo 且 anchorTo.messageId 能匹配到同 conversation 的 assistant 消息 → 进 anchoredByMsg
 *   （保持数组序；同回合多张卡相对顺序不变）；
 * - 卡带 anchorTo 但匹配不到 → 优雅降级留顶层流按 createdAt 沉流尾（不丢卡），并计降级计数；
 * - 老卡无 anchorTo → 留顶层流，行为不变（兼容）。
 * - 非 message 项（proposal / 折叠组）不在锚点处理范围，原样透传、位置不变。
 *
 * @param items foldBashProposalGroups / foldSubagentGroups 之后的时间线
 * @returns topItems（已抽离锚定卡的顶层流，含透传的非 message 项，项类型 T 原样保留）+
 *   anchoredByMsg（messageId → 锚定卡 ChatMessage[]）
 */
export function detachAnchoredCards<T extends TimelineItem>(
  items: ReadonlyArray<T>,
): { topItems: T[]; anchoredByMsg: Map<string, ChatMessage[]> } {
  const topItems: T[] = [];
  const anchoredByMsg = new Map<string, ChatMessage[]>();

  // 先收集本 conversation 全域的 assistant 消息 id（role=assistant 且无 kind 的普通回复）——锚定目标
  // 由 chat.started 在回合一开始就建好、恒先于卡存在；这里全量收集一遍，兜住极端重放顺序。
  const anchorTargets = new Set<string>();
  for (const it of items) {
    if (it.kind !== 'message') continue;
    const d = it.data as Partial<ChatMessage>;
    if (d.role === 'assistant' && d.kind === undefined && d.id) anchorTargets.add(d.id);
  }

  for (const it of items) {
    if (it.kind !== 'message') {
      // 非 message 项（proposal / 折叠组）不在锚点处理范围，原样透传
      topItems.push(it);
      continue;
    }
    const d = it.data as Partial<ChatMessage>;
    // 只抽 kind 属于锚定集合、且带 anchorTo 的卡；其余原样留在顶层流
    if (d.kind && ANCHORED_CARD_KINDS.has(d.kind) && d.anchorTo?.messageId) {
      const target = d.anchorTo.messageId;
      if (anchorTargets.has(target)) {
        const arr = anchoredByMsg.get(target);
        if (arr) arr.push(it.data as ChatMessage);
        else anchoredByMsg.set(target, [it.data as ChatMessage]);
        continue; // 不落顶层
      }
      // 匹配不到锚定消息 → 优雅降级：留顶层沉流尾 + 计 dev 级计数
      anchorCardMissCount.value += 1;
      topItems.push(it);
      continue;
    }
    topItems.push(it);
  }

  return { topItems, anchoredByMsg };
}
