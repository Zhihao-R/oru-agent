/**
 * 远程审批卡投影登记表 + 平台投影器注册表（S24 · G30 下半）。
 *
 * 一份审批实体可投影到多个渠道地址；决定回流到同一实体，先到先得。本模块是「投影副本」这一侧的
 * 收口：谁能投（按平台能力声明）、投了哪些副本（登记表）、决定落定后把副本刷成终态、提案作废时
 * 清副本。核心判定（谁赢、落存证、驱动执行）在 settleApprovalDecision，本模块只管副本。
 *
 * 投影器由 platformManager 连接平台时注册（成对注销），与 outbound.ts 的 senders 同范式——
 * 声明 'text'/'none' 的适配器不注册按钮方法，approvalCapabilityOf 回落 'none'。
 *
 * 登记表清理两条出口都必须显式接：决定收口（refreshProjectionsToTerminal 改写后删表项）；
 * 提案作废（对话 abort / 撤卡，经 clearProjections）——否则 abort 的提案投影永留 Map 泄漏。
 */
import type { Platform, RemoteApprovalCard } from '@shared/platform/message';
import type { ProposalRecord } from '@shared/types';
import type { ChannelAddress } from './outbound';

type ApprovalProjector = {
  capability: 'button' | 'text' | 'none';
  /** button 级必实现：发出投影卡，返回平台侧消息 id（用于事后改写成终态）。 */
  sendApprovalCard?: (chatId: string, card: RemoteApprovalCard) => Promise<{ platformMessageId: string } | null>;
  /** 把已发出的投影卡原地改写成终态（飞书更新卡片 / Discord 编辑消息）。 */
  updateApprovalCardToTerminal?: (
    chatId: string,
    platformMessageId: string,
    decision: ProposalRecord['decision'],
  ) => Promise<void>;
};

const projectors = new Map<Platform, ApprovalProjector>();

export function registerApprovalProjector(platform: Platform, projector: ApprovalProjector): void {
  projectors.set(platform, projector);
}
export function unregisterApprovalProjector(platform: Platform): void {
  projectors.delete(platform);
}

/** 该平台的审批能力（未注册即未连接 → 'none'）。channelOutbound 据此分流投影 vs 回落拒绝。 */
export function approvalCapabilityOf(platform: Platform): 'button' | 'text' | 'none' {
  return projectors.get(platform)?.capability ?? 'none';
}

type RemoteProjection = { platform: Platform; chatId: string; platformMessageId: string };
const projections = new Map<string, RemoteProjection[]>();

/**
 * 把一份审批卡投影到给定渠道地址（只对 button 能力的平台）。返回是否至少投出一份——
 * 调用方据此决定是否「不 settle、不拒绝、等按钮回流」。发送失败只 warn（渠道卡是副本、非承重）。
 */
export async function projectApprovalCard(
  proposalId: string,
  targets: ChannelAddress[],
  card: RemoteApprovalCard,
): Promise<boolean> {
  let projected = false;
  for (const t of targets) {
    const p = projectors.get(t.platform);
    if (p?.capability !== 'button' || !p.sendApprovalCard) continue;
    try {
      const r = await p.sendApprovalCard(t.chatId, card);
      if (r) {
        const list = projections.get(proposalId) ?? [];
        list.push({ platform: t.platform, chatId: t.chatId, platformMessageId: r.platformMessageId });
        projections.set(proposalId, list);
        projected = true;
      }
    } catch (e) {
      console.warn(`[approval] ${t.platform} 投影卡发送失败（${proposalId}）：${String(e)}`);
    }
  }
  return projected;
}

/**
 * 决定落定后把该提案的全部渠道投影原地刷成终态并清表项。改写失败只 warn 不影响判定
 * （本地是事实源，渠道卡只是副本，approval.html:197）。
 */
export async function refreshProjectionsToTerminal(
  proposalId: string,
  decision: ProposalRecord['decision'],
): Promise<void> {
  const list = projections.get(proposalId);
  if (!list) return;
  for (const proj of list) {
    try {
      await projectors.get(proj.platform)?.updateApprovalCardToTerminal?.(proj.chatId, proj.platformMessageId, decision);
    } catch (e) {
      console.warn(`[approval] ${proj.platform} 投影卡改写终态失败（${proposalId}）：${String(e)}`);
    }
  }
  projections.delete(proposalId);
}

/** 提案作废（abort / 撤卡）时清副本，避免登记表泄漏。 */
export function clearProjections(proposalId: string): void {
  projections.delete(proposalId);
}

/** 测试 hook。 */
export function __resetApprovalProjectionForTest(): void {
  projectors.clear();
  projections.clear();
}
