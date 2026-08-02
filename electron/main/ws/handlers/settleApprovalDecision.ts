/**
 * 审批决定收口——桌面与所有渠道共用的**唯一出口**（S24）。
 *
 * 桌面点击（proposal.execute / reject）与渠道按钮回流都汇入这里，先到先得：谁先到谁的决定生效，
 * 其余投影随后刷成终态。一处收口保证五条路径（桌面批/拒、渠道批/拒、附言拒）落存证一次不重不漏、
 * 授权写入单源、投影改写单源。
 *
 * 先到先得的原子门（CLAUDE.md「await 后重检」）：状态仍 pending 且本端首个认领（synchronous claim，
 * 无 await 间隔）→ 本端赢，其余并发调用在门口即返回 already-decided。既有 settleProposalDecision 的
 * 返回值有两义（waiter 从未注册 / 已被先到者消费），不足以判「已决定」，故以 claim + status 复检为准。
 *
 * 卡收敛（G31）：本模块只落「决定终态」（存证 approved/rejected）+ 驱动执行；status 机
 * （executing/executed/failed）照旧由工具回报推进，是内部编排事实源，卡片与存证不复述它。
 */
import type { ActionProposal, ProposalRecord } from '@shared/types';
import type { Broadcast } from '../server';
import { getProposal } from '../../proposals/registry';
import { maybeResumeTurn } from './resumeTurn';
import { transitionProposal } from '../../proposals/lifecycle';
import { persistProposalDecision } from '../../proposals/persistDecision';
import { refreshProjectionsToTerminal } from '../../platform/approvalProjection';
import { addGrant } from '../../proposals/grants/store';
import { grantLabel } from '../../proposals/grants/label';
import {
  settleProposalDecision,
  registerProposalFinalizer,
  unregisterProposalFinalizer,
  hasToolAwaited,
} from '../../proposals/pendingDecision';
import { enqueue as enqueueTask, cancelInQueue } from '../../tasks/queue';
import { listAgents } from '../../agent/store/agents';
import { writeRejectionSystemEvent } from '../../proposals/systemEvent';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { getSettings } from '../../projects/store';
import { claimDecision, forgetDecisionClaim } from '../../proposals/decisionClaim';

export type ApprovalSettleResult = {
  status: 'settled' | 'already-decided';
  /** always 授权写盘是否失败（settled + approved + always 时才有意义）。 */
  grantPersistFailed?: boolean;
};

/**
 * 决定的副记录：落存证（G130）+ 刷渠道投影终态（G30）。fire-and-forget——两者各自内部兜错、不承重
 * （落盘失败仅缺存证、投影改写失败不影响判定），不该阻塞收口在磁盘 IO / 渠道网络上。
 */
function recordDecision(
  proposal: ActionProposal,
  decision: ProposalRecord['decision'],
  by: ProposalRecord['by'],
  broadcast: Broadcast,
  grantPersistFailed?: boolean,
): void {
  void persistProposalDecision(proposal, decision, by, broadcast, grantPersistFailed);
  void refreshProjectionsToTerminal(proposal.id, decision);
}

export async function settleApprovalDecision(p: {
  proposalId: string;
  decision: ProposalRecord['decision'];
  /** 点的是「始终允许」（decision==='approved' 时才写授权）。 */
  always: boolean;
  by: ProposalRecord['by'];
  broadcast: Broadcast;
  /** 拒绝附言（decision==='rejected' 时）。 */
  note?: string;
}): Promise<ApprovalSettleResult> {
  const proposal = getProposal(p.proposalId);
  if (!proposal) return { status: 'already-decided' };
  // 同步原子门（无 await 间隔）：状态仍 pending 且本端首个认领 → 本端独占；其余并发调用门口返回。
  if (proposal.status !== 'pending' || !claimDecision(p.proposalId)) {
    return { status: 'already-decided' };
  }

  if (p.decision === 'rejected') return rejectDecision(proposal, p.by, p.broadcast, p.note);
  return approveDecision(proposal, p.always, p.by, p.broadcast);
}

async function rejectDecision(
  proposal: ActionProposal,
  by: ProposalRecord['by'],
  broadcast: Broadcast,
  note?: string,
): Promise<ApprovalSettleResult> {
  const trimmed = note?.trim() || undefined;
  // 存证与渠道投影是决定的副记录（内部各自兜错），fire-and-forget——不阻塞收口在磁盘/网络上，
  // 也不在唤醒工具后再插 await 让工具的 rejection 悬空。persist 内部保证 append 先于自身广播（§7）。
  recordDecision(proposal, 'rejected', by, broadcast);
  transitionProposal(proposal, 'rejected', broadcast);
  if (proposal.kind === 'code') cancelInQueue(proposal.id);
  // 同步审批：工具拿到「拒绝」作为 tool_result，原轮自然继续——无附言则无需系统记 / 续跑。
  if (settleProposalDecision(proposal.id, 'rejected')) {
    if (trimmed) await writeRejectionSystemEvent(proposal.conversationId, proposal.id, trimmed);
    return { status: 'settled' };
  }
  // settle 落空 + 曾有工具在等 = 僵尸卡：仅在有附言时落系统记留痕，不续跑（工具早已不在等）。
  if (hasToolAwaited(proposal.id)) {
    if (trimmed) await writeRejectionSystemEvent(proposal.conversationId, proposal.id, trimmed);
    return { status: 'settled' };
  }
  // 从没有工具等过（设置页起的卡 / code 派工）：写系统记 + 尝试续跑，模型下一轮看到接着干。
  await writeRejectionSystemEvent(proposal.conversationId, proposal.id, trimmed);
  void maybeResumeTurn(proposal.conversationId, broadcast);
  return { status: 'settled' };
}

async function approveDecision(
  proposal: ActionProposal,
  always: boolean,
  by: ProposalRecord['by'],
  broadcast: Broadcast,
): Promise<ApprovalSettleResult> {
  // 「始终允许」：批准前先把全部 grantable scope 写授权（写在唤醒工具之前，先后无关但语义清晰）。
  let grantPersistFailed = false;
  if (always && proposal.grantable?.length) {
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    for (const scope of proposal.grantable) {
      const r = await addGrant(scope, grantLabel(scope, proposal, lang));
      if (!r.persisted) grantPersistFailed = true;
    }
  }

  // 驱动执行：先注册 finalizer 再 settle（保证工具回报终态有挂载点）。转 executing 紧接 settle、
  // 中间零 await——避免被唤醒的工具抢先 finalize 到 executed 后本端再转 executing 撞非法迁移。
  registerProposalFinalizer(proposal.id, (outcome) =>
    transitionProposal(
      proposal,
      outcome.status,
      broadcast,
      outcome.status === 'failed' ? { failureMessage: outcome.failureMessage } : undefined,
    ),
  );
  const woke = settleProposalDecision(proposal.id, 'approved');
  if (woke) {
    transitionProposal(proposal, 'executing', broadcast);
    recordDecision(proposal, 'approved', by, broadcast, grantPersistFailed); // fire-and-forget，见 rejectDecision 注
    return { status: 'settled', grantPersistFailed };
  }
  unregisterProposalFinalizer(proposal.id);

  // settle 落空 + 曾有工具在等 = 僵尸卡：工具早已不在等，命令不执行（保持现状静默作废，不落决定存证——
  // 无决定被真正兑现）。渠道投影随之刷成 rejected（若有）。判据是提案自身的事实而非 kind：装卸类
  // 同时有设置页入口，那条路径从没有工具等过，必须落到下面的独立执行分支去（否则卸载 / 新建永不执行）。
  if (hasToolAwaited(proposal.id)) {
    transitionProposal(proposal, 'rejected', broadcast);
    void refreshProjectionsToTerminal(proposal.id, 'rejected');
    return { status: 'settled', grantPersistFailed };
  }

  // 从没有工具等过（设置页起的卡 / code 派工；工具起卡后走人的僵尸卡已在上一步兜住）：
  // 决定真实兑现 → 落存证 + 刷投影，再派工 / 交独立执行器。
  recordDecision(proposal, 'approved', by, broadcast, grantPersistFailed);
  const { isExecuting } = await import('../../proposals/standaloneExec');
  // 信任模式 in-flight（onProposal 内 runProposalStandalone 已在跑，status 仍 pending 数秒）：不重复执行。
  if (proposal.kind !== 'code' && isExecuting(proposal.id)) return { status: 'settled', grantPersistFailed };
  if (proposal.kind === 'code') {
    const { activeId } = await listAgents();
    // await 后重检：listAgents 期间可能已被别的路径改态（enqueue 内还有 proposalId 幂等兜底）。
    if (activeId && proposal.status === 'pending') {
      enqueueTask({ agentId: activeId, proposal, emit: broadcast });
    }
    // code 派工后 status 仍 pending（排队中）——释放决定认领，让用户改主意时的「拒绝」能撤下排队任务
    // （approve→queued→reject 是既有 UX，见 queueProposalLifecycle 回归）。并发重复 approve 由 enqueue
    // 幂等兜住；卡片批准后即被存证卡替换，UI 上无第二次点击面。
    forgetDecisionClaim(proposal.id);
  } else {
    const convId = proposal.conversationId;
    const { runProposalStandalone } = await import('../../proposals/standaloneExec');
    void runProposalStandalone(proposal, broadcast).then(() => maybeResumeTurn(convId, broadcast));
  }
  return { status: 'settled', grantPersistFailed };
}
