/**
 * 把时间线里「相邻的终态 subagent 完成行」折成一组（2026-07-30 拍板：完成卡降级为工具行）。
 *
 * - 输入是 foldBashProposalGroups 的输出（ChatArea items 层）；与 bash 提案折叠同款相邻分组，
 *   但自成一类计数——工具是主 agent 的动作，subagent 是派出去的孩子，不混计。
 * - 只折相邻、kind==='subagent' 且已终态（completed/error）的消息；运行中（含等审批）
 *   由底部 SubagentBar 承载不进折，且会断开相邻组。
 * - 渲染层据此：组内 1 条 → 单行；≥2 条 → 「N 个 subagent」折叠行，点开逐行。
 *
 * 纯函数（不依赖 React / store），便于直接单测核心折叠规则。
 */
import type { ChatMessage, SubagentChipRef } from '@shared/types';
import type { FoldedItem } from './foldBashProposalGroups';

/** 终态 subagent 消息判定：完成行才入流折叠（本文件与 SubagentChip 渲染守卫共用同一口径） */
export function isTerminalSubagentMessage(
  m: ChatMessage,
): m is ChatMessage & { subagent: SubagentChipRef } {
  return (
    m.kind === 'subagent' &&
    m.subagent != null &&
    (m.subagent.status === 'completed' || m.subagent.status === 'error')
  );
}

export type SubagentFoldedItem =
  | FoldedItem<ChatMessage>
  | { kind: 'subagentGroup'; key: string; ts: number; data: ChatMessage[] };

export function foldSubagentGroups(
  items: ReadonlyArray<FoldedItem<ChatMessage>>,
): SubagentFoldedItem[] {
  const folded: SubagentFoldedItem[] = [];
  for (const it of items) {
    if (it.kind === 'message' && isTerminalSubagentMessage(it.data)) {
      const prev = folded[folded.length - 1];
      if (prev && prev.kind === 'subagentGroup') {
        prev.data.push(it.data);
        continue;
      }
      folded.push({ kind: 'subagentGroup', key: `subagentgroup_${it.key}`, ts: it.ts, data: [it.data] });
      continue;
    }
    folded.push(it);
  }
  return folded;
}
