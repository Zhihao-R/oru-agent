/**
 * 把时间线里"连续的 bash 提案"折成一组（决策 2）。
 *
 * - 只折相邻、kind==='bash' 的提案；中间一旦插入消息或别类提案即断开。
 * - 不按 status 过滤：组成员含已 executed/rejected 的，成员集稳定，carousel 才翻得稳。
 * - 渲染层据此：组内 1 条 → 退化单卡；多条 → 翻页卡。
 *
 * 纯函数（不依赖 React / store），便于直接单测核心折叠规则。消息侧用泛型 M（折叠只关心提案）。
 */
import type { ActionProposal, BashProposal } from '@shared/types';

export type TimelineItem<M> =
  | { kind: 'message'; key: string; ts: number; data: M }
  | { kind: 'proposal'; key: string; ts: number; data: ActionProposal };

export type FoldedItem<M> =
  | TimelineItem<M>
  | { kind: 'proposalGroup'; key: string; ts: number; data: BashProposal[] };

export function foldBashProposalGroups<M>(
  items: ReadonlyArray<TimelineItem<M>>,
): FoldedItem<M>[] {
  const folded: FoldedItem<M>[] = [];
  for (const it of items) {
    if (it.kind === 'proposal' && it.data.kind === 'bash') {
      const prev = folded[folded.length - 1];
      if (prev && prev.kind === 'proposalGroup') {
        prev.data.push(it.data);
        continue;
      }
      folded.push({ kind: 'proposalGroup', key: `bashgroup_${it.data.id}`, ts: it.ts, data: [it.data] });
      continue;
    }
    folded.push(it);
  }
  return folded;
}
