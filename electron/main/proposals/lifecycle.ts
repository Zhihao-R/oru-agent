/**
 * Proposal 状态机——status 流转 + statusChanged 广播的唯一入口。
 *
 * 此前 status 赋值 + broadcast 散布在 router / 独立执行器 / 各 executor 共 12 处，
 * 「先广播 executed 再执行」这类时序错误（假已执行 bug）写得出来且没人拦。
 * 收口后：非法迁移直接 throw（开发期暴露），广播载荷与赋值永远一致。
 *
 * 合法流转：
 *   pending   → executing | executed | failed | rejected
 *   executing → executed | failed
 *   终态（executed / failed / rejected）不再迁移
 *
 * executing 的使用面（都表示「执行已开始，拒绝再无撤回路径」）：
 * - 同步审批 kind（bash / file.write）：批准 → executing → 工具完成经 finalizeProposalExecution 回报终态；
 * - mcp / plugin / skill / deck：独立执行器开跑即迁（都有数秒执行窗口，占住状态挡 reject），
 *   各执行器内部的 finalize 再从 executing 迁终态；
 * - code：queue 起跑即迁（排队中保持 pending，可经 cancelInQueue 撤下）。
 */
import type { ActionProposal, ProposalStatus } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';

type Broadcast = (ev: ServerEvent) => void;

const LEGAL: Record<ProposalStatus, readonly ProposalStatus[]> = {
  pending: ['executing', 'executed', 'failed', 'rejected'],
  executing: ['executed', 'failed'],
  executed: [],
  failed: [],
  rejected: [],
};

/**
 * 迁移 proposal 状态并广播 proposal.statusChanged。
 * failureMessage 只在 next === 'failed' 时落到 proposal 上——executed + failureMessage
 * 并存是自相矛盾的语义（下游按 failureMessage 判错会误报），状态机直接挡住。
 */
export function transitionProposal(
  proposal: ActionProposal,
  next: Exclude<ProposalStatus, 'pending'>,
  broadcast: Broadcast,
  extra?: { failureMessage?: string; serverId?: string },
): void {
  if (!LEGAL[proposal.status].includes(next)) {
    throw new Error(`非法 proposal 状态迁移：${proposal.status} → ${next}（${proposal.id}）`);
  }
  proposal.status = next;
  if (next !== 'executing') proposal.completedAt = Date.now();
  if (next === 'failed' && extra?.failureMessage) proposal.failureMessage = extra.failureMessage;
  broadcast({
    type: 'proposal.statusChanged',
    proposalId: proposal.id,
    status: next,
    completedAt: proposal.completedAt,
    failureMessage: next === 'failed' ? extra?.failureMessage : undefined,
    serverId: extra?.serverId,
  });
}
