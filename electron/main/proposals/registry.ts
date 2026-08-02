/**
 * Proposal 内存注册表——主分身通过派工（Task async / propose_* 族）递交的提案在被用户决策（或自动派工）前的临时家。
 *
 * 依赖方向修正（2026-07-22 盘点 M6）：注册表原住在传输层 ws/handlers/shared.ts，导致
 * tasks/subagentRunner、scheduledTasks/executor、loop/orchestrate 三处下层服务 `await import('../ws/router')`
 * 反向够上来取 surfaceProposal——动态 import 掩住了这个倒置的环。注册表本是 proposal 子系统的一等公民
 * （与 lifecycle / decisionClaim / persistDecision 同层），下沉到此后 ws 层转为消费方、三处服务改正向静态依赖。
 *
 * 只依赖 `Broadcast` 类型（值由调用方传入，编译期擦除、无运行时环）——与 persistDecision.ts 同样的既有约定。
 */
import type { ActionProposal } from '@shared/types';
import type { Broadcast } from '../ws/server';
import { transitionProposal } from './lifecycle';
import { clearProjections } from '../platform/approvalProjection';
import { forgetDecisionClaim } from './decisionClaim';
import { forgetRecordedDecision } from './persistDecision';
import { abortProposalDecision, forgetToolAwaited } from './pendingDecision';

// 主分身通过 Task(mode=async) / propose_* 族工具递交的提案 → 临时缓存，等用户决策（或自动派工）
// 简单 LRU：超过 100 条丢最早的
const proposals = new Map<string, ActionProposal>();
const PROPOSAL_LIMIT = 100;

export function rememberProposal(p: ActionProposal): void {
  if (proposals.size >= PROPOSAL_LIMIT) {
    const oldest = proposals.keys().next().value;
    if (oldest) {
      proposals.delete(oldest);
      forgetProposalSideChannels(oldest); // 淘汰时连带清认领集 / 投影表，防随 LRU 泄漏
    }
  }
  proposals.set(p.id, p);
}

/** 提案离场（LRU 淘汰 / discard）时清掉挂在它 id 上的决定认领 / 存证幂等门 / 渠道投影副本 / 同步等待留痕，防内存泄漏。 */
function forgetProposalSideChannels(id: string): void {
  // 先兑现可能在同步等待的工具——「算了」走 discard 不兑现的话，turn 永远停在工具等待点
  // （UI 永挂「正在调用」、turn-inflight 残留 running）；LRU 淘汰同走此函数，一处封死两条路。
  // abortProposalDecision 对无 waiter 的 id 是幂等 no-op。
  abortProposalDecision(id);
  forgetDecisionClaim(id);
  forgetRecordedDecision(id);
  clearProjections(id);
  forgetToolAwaited(id);
}

export function getProposal(id: string): ActionProposal | undefined {
  return proposals.get(id);
}

export function discardProposal(id: string): boolean {
  forgetProposalSideChannels(id);
  return proposals.delete(id);
}

/**
 * 把审批卡登记进 proposals Map 并广播到它所属对话——「surface 一张审批卡」的单一入口。
 * 主对话 onProposal 与后台 subagent 审批回流共用，避免 rememberProposal + 广播在多处各写一份漂移。
 * 广播按 proposal.conversationId 路由（主对话 proposal 即主对话 id；后台 subagent 回流前已改写为主对话 id）。
 */
export function surfaceProposal(proposal: ActionProposal, broadcast: Broadcast): void {
  rememberProposal(proposal);
  broadcast({ type: 'chat.proposal', conversationId: proposal.conversationId, proposal });
}

/**
 * 取消后台任务时撤掉它悬在主对话的审批卡（C 块「前端撤卡」）：后端 waiter 已经 abortSignal 干净
 * settle 成 aborted，但那张 emit 出去的 pending 卡不会自己消失——显式转 rejected 终态 + 广播，
 * 前端据 proposal.statusChanged 把它从 pending 移出（未读随之递减），防悬挂卡。
 */
export function cancelSubagentProposals(taskId: string, broadcast: Broadcast): void {
  for (const p of proposals.values()) {
    if (p.status === 'pending' && p.triggeredBySubagent?.taskId === taskId) {
      transitionProposal(p, 'rejected', broadcast);
      clearProjections(p.id); // 撤卡：作废的提案渠道投影一并清（否则永留登记表泄漏，S24 §3.3）
    }
  }
}

/**
 * 该会话还有几条未处理完的提案（"整批处理完"= 0）。注：proposals Map 只登记需审批的提案。
 * executing 也算未处理完：mcp/code 现在执行期占 executing（原先整个执行期都停在 pending），
 * 不算进去会让续跑在环境变更落定前提前触发、且与执行完成后的 .then(maybeResumeTurn) 双触发。
 */
export function countPendingProposals(conversationId: string): number {
  let n = 0;
  for (const proposal of proposals.values()) {
    if (
      proposal.conversationId === conversationId &&
      (proposal.status === 'pending' || proposal.status === 'executing')
    )
      n += 1;
  }
  return n;
}
