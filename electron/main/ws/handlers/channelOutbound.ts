/**
 * 统一回合装配的「渠道出站」接线（S10）——回发与提案远程语义从「回合闭包」解绑到这里，挂在
 * 统一回合装配上，对「谁起的回合」不敏感：桌面起的回合中途插入了一条飞书消息，回复照发回飞书。
 *
 * 判据只看本回合消费的输入 origin 集合（turnInputs）：含渠道 origin 即「渠道回合」，走远程语义 +
 * 回发；纯桌面回合两个函数都 no-op（返回未处理 / 不回发）。§4 / §5。
 */
import type { ActionProposal, Agent, Conversation, TriggerOrigin } from '@shared/types';
import type { RemoteApprovalCard } from '@shared/platform/message';
import type { ServerEvent } from '@shared/protocol';
import { resolveOutboundTargets, deliverToChannel } from '../../platform/outbound';
import { clearProcessing } from '../../platform/channelProcessing';
import { decidePlatformProposal } from '../../platform/platformTurn';
import { approvalCapabilityOf, projectApprovalCard } from '../../platform/approvalProjection';
import { hasToolAwaited, forgetToolAwaited } from '../../proposals/pendingDecision';
import { redactSecrets } from '../../platform/redact';
import { realtimeApprovalModeFor } from '../../agent/store/agents';
import { behaviorForProposal } from '@shared/proposals/behaviors';
import { transitionProposal } from '../../proposals/lifecycle';
import { enqueue as enqueueTask } from '../../tasks/queue';
import { getSettings } from '../../projects/store';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { t } from '../../i18n/t';

/** 本回合消费输入的 origin 投影（起回合那条 + 间隙插入批 + restart 批）。 */
export type TurnInput = { origin?: TriggerOrigin };

const noopBroadcast = (_ev: ServerEvent): void => {};

/**
 * 回合出站完成后：把 assistant 回复回发到本回合消费的渠道来源（去重），并清掉这些消息的
 * 「处理中」表情（§6：清除时机 = 该消息被消费的回合出站完成时）。纯桌面回合 → 无目标、无表情，no-op。
 */
export async function deliverAssistantToChannels(
  turnInputs: TurnInput[],
  conversation: Conversation,
  assistantText: string,
): Promise<void> {
  const targets = resolveOutboundTargets(turnInputs, conversation);
  for (const target of targets) {
    await deliverToChannel(target, assistantText);
  }
  // 按本回合消费集逐条清表情——同 chat 还在排队的其他消息表情不被误清（§6）。
  for (const { origin } of turnInputs) {
    if (origin) await clearProcessing(origin);
  }
}

/** 提案 → 平台无关投影卡数据（S24 · G30）：正文脱敏；always 按钮仅当可持久授权（有 grantable）时出。
 *  标题经行为注册表取行为类型（2026-07-30 决策 1，与桌面卡同一单源）；不在分类面的提案回落原 title。 */
async function buildRemoteApprovalCard(proposal: ActionProposal): Promise<RemoteApprovalCard> {
  const buttons: RemoteApprovalCard['buttons'] = ['allow'];
  if (proposal.grantable?.length) buttons.push('always');
  buttons.push('reject');
  const behavior = behaviorForProposal(proposal);
  const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
  return {
    proposalId: proposal.id,
    title: redactSecrets(behavior ? t(`proposal:${behavior.titleKey}`, lang) : proposal.title),
    body: redactSecrets(proposal.description),
    buttons,
  };
}

/**
 * 渠道回合的提案远程处置（S24 · G30 下半）——回合输入含渠道 origin 即走此路，按适配器审批能力分流：
 *  - button 渠道（飞书互动卡片）：把审批实体投影成渠道原生按钮卡，**不 settle、不拒绝**，桌面卡
 *    同时在（返回 false 让桌面卡也弹），多端并存、先到先得，等任一端点击经 settleApprovalDecision 收口。
 *  - text / none 渠道（Discord 本期）：回落现状——需审批的操作远程不静默执行，有工具在同步等的拒 +
 *    回提示换挡，从没有工具等过的按挡位 decidePlatformProposal 执行 / 拒（镜像桌面 danger 放行）。
 * 返回 true = 已按远程语义处理（调用方 return，不再弹桌面卡）；false = 交回桌面卡路（含 button 投影后）。
 *
 * 判定时刻是提案触发那一刻（onProposal 内现查 turnInputs 引用）：桌面起的回合在渠道插话前触发的
 * 提案走桌面卡、之后触发的走远程语义，按「彼时集合」如实分流。
 */
export async function handleChannelProposalIfRemote(p: {
  proposal: ActionProposal;
  turnInputs: TurnInput[];
  conversation: Conversation;
  agentId: string;
  agent: Agent;
}): Promise<boolean> {
  const handled = await dispatchChannelProposal(p);
  // 返回 true = 该提案的生命周期在此终结：不弹桌面卡、永不进 proposals 注册表，故注册表离场那条
  // 常规清理路径够不着它。在唯一出口显式释放「曾有工具在等」留痕，否则 text/none 渠道每触发一次
  // 需审批的操作就漏一条，长驻主进程里无界增长。
  if (handled) forgetToolAwaited(p.proposal.id);
  return handled;
}

async function dispatchChannelProposal(p: {
  proposal: ActionProposal;
  turnInputs: TurnInput[];
  conversation: Conversation;
  agentId: string;
  agent: Agent;
}): Promise<boolean> {
  const targets = resolveOutboundTargets(p.turnInputs, p.conversation);
  if (targets.length === 0) return false; // 纯桌面回合 → 桌面卡

  // button 能力渠道：投影可点审批卡，桌面卡并存，等任一端点击经 settleApprovalDecision 收口。
  const buttonTargets = targets.filter((tg) => approvalCapabilityOf(tg.platform) === 'button');
  if (buttonTargets.length > 0) {
    const projected = await projectApprovalCard(p.proposal.id, buttonTargets, await buildRemoteApprovalCard(p.proposal));
    if (projected) return false; // 让桌面卡也弹（surfaceProposal）——多端并存，先到先得
    // 投影全失败（网络等）→ 不留悬空，回落到下面的拒绝路径
  }

  const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
  const blockedMsg = t('main:platform.approvalBlocked', lang);
  const notifyBlocked = async () => {
    for (const target of targets) await deliverToChannel(target, blockedMsg);
  };

  // text / none 回落：需审批的操作远程不静默执行。
  // 有工具在同步等：settle 命中即拒 + 回提示，唤醒挂起的工具（否则 turn 永久挂起）。
  const { settleProposalDecision } = await import('../../proposals/pendingDecision');
  if (settleProposalDecision(p.proposal.id, 'rejected')) {
    await notifyBlocked();
    return true;
  }
  // 曾有工具在等、但 settle 落空（背景 / 已 abort）：绝不落 decidePlatformProposal（danger 挡下会被
  // 误当无人等的卡判执行）——直接作废（S24 §2 修正 settle-miss 漏进异步分支）。
  if (hasToolAwaited(p.proposal.id)) {
    transitionProposal(p.proposal, 'rejected', noopBroadcast);
    await notifyBlocked();
    return true;
  }
  // 从没有工具等过的卡（code 派工 / 设置页起卡）：按全局挡位决定执行 / 拒绝（镜像桌面）。
  const mode = await realtimeApprovalModeFor(p.agentId, p.agent.approvalMode);
  const action = decidePlatformProposal(p.proposal, mode);
  if (action.kind === 'execute') {
    if (p.proposal.kind === 'code') enqueueTask({ agentId: p.agentId, proposal: p.proposal, emit: noopBroadcast });
    else {
      const { runProposalStandalone } = await import('../../proposals/standaloneExec');
      void runProposalStandalone(p.proposal, noopBroadcast);
    }
    return true;
  }
  transitionProposal(p.proposal, 'rejected', noopBroadcast);
  await notifyBlocked();
  return true;
}
