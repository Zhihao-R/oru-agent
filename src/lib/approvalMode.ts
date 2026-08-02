/**
 * 审批挡位读取 helper（2026-08-02 抽：TaskCard / SubagentBar / CodeProposalCard 共用同一口径）。
 *
 * code 派工可视性语义（用户 2026-08-02 拍板"code 派工当工具走审批"）：
 * - work / danger：code 派工 auto 执行（router 自动 enqueue），排队→运行全部由底部 SubagentBar
 *   的「排队中」行承载，消息流内不铺静态卡（避免与排队行双呈现）。
 * - readonly：router 不自动派工，code 派工是**真审批**，留在消息流内 CodeProposalCard
 *   （[让他去做][算了]）走工具审批；SubagentBar 不收 readonly 的 code 排队（避免和审批卡双呈现）。
 */
import { useAgentStore } from '@/stores/agentStore';

/** 当前 active agent 是否只读挡（readonly）——approvalMode 三态，非 readonly 即 work/danger */
export function useIsReadonly(): boolean {
  return useAgentStore(
    (s) => (s.agents.find((a) => a.id === s.activeAgentId)?.approvalMode ?? 'work') === 'readonly',
  );
}
