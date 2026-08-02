/**
 * 审批决定存证落盘（S24 · G130）——生产者单源。
 *
 * 决定收口的唯一出口 settleApprovalDecision 在决定落定那一刻调本函数：append 一条 kind:'proposal'
 * 消息进对话 JSONL（承载决定终态、不承载执行）+ 广播 chat.proposalRecord（前端把内存活卡替换为
 * 历史存证卡）。一条提案落一条、immutable。落盘走 appendMessage 的原子写，本就崩溃安全。
 *
 * 先落盘、后广播（§7）：append 成功再广播 chat.proposalRecord，保证「广播出去的存证」在历史里必有
 * 对应记录，不产生孤儿。落盘失败只 warn 不抛——决定已在核心落定，缺存证是可容忍的降级（崩溃前
 * 未落盘的提案重启后仍是 pending、活卡不在、无害），绝不该把「落盘失败」升级成「决定回滚」。
 */
import type { ActionProposal, ChatMessage, ProposalRecord } from '@shared/types';
import type { Broadcast } from '../ws/server';
import { newMessageId } from '@shared/ids';
import { findAgentForConversation } from '../plugins/appendMessage';
import { appendMessage } from '../conversations/store';

/**
 * 已落存证的提案 id（幂等门）——「一条提案落一条、immutable」（§3.2）。首个决定即终态：
 * code 提案批准入队后 approveDecision 会 forgetDecisionClaim 放开认领（为支持「approve→排队→拒绝撤队」
 * 的既有 UX），此后若真拒绝会重入 settleApprovalDecision 再落一条 rejected 存证——本门挡住第二次落盘，
 * 卡面「决定」保持首个（已批准），撤队是任务层的事、不改写决定存证。同理挡并发重复 approve 的双落。
 * 提案离场（discard / LRU 淘汰）时经 forgetRecordedDecision 清，防泄漏。
 */
const recorded = new Set<string>();
export function forgetRecordedDecision(proposalId: string): void {
  recorded.delete(proposalId);
}

/** 落盘那一刻从 proposal 快照生成的人话摘要——脱离内存 Map 也能读懂这条决定。 */
export function summarizeProposal(proposal: ActionProposal): string {
  switch (proposal.kind) {
    case 'bash':
      return proposal.command;
    case 'file.write':
      return `${proposal.mode} ${proposal.path}`;
    case 'web.fetch':
    case 'browser.navigate':
      return proposal.url;
    default: {
      // 其余（code / mcp / plugin / skill / deck / scheduled-task）title 已是人话卡标题；
      // 带对外投递的再并上目标，让存证脱离内存也读得懂送去了哪。
      const base = proposal.title;
      const targets = proposal.delivery?.map((d) => d.label).join('、');
      return targets ? `${base}（外发：${targets}）` : base;
    }
  }
}

export async function persistProposalDecision(
  proposal: ActionProposal,
  decision: ProposalRecord['decision'],
  by: ProposalRecord['by'],
  broadcast: Broadcast,
  grantPersistFailed?: boolean,
): Promise<void> {
  // 幂等门（同步认领，无 await 间隔）：一条提案只落一条存证，首个决定为准。
  if (recorded.has(proposal.id)) return;
  recorded.add(proposal.id);
  try {
    const agentId = await findAgentForConversation(proposal.conversationId);
    if (!agentId) {
      console.warn(`[proposal] 找不到 conversation ${proposal.conversationId} 所属 agent，决定存证丢弃`);
      return;
    }
    const record: ProposalRecord = {
      proposalId: proposal.id,
      decision,
      by,
      summary: summarizeProposal(proposal),
      decidedAt: Date.now(),
      ...(grantPersistFailed ? { grantPersistFailed: true } : {}),
    };
    const msg: ChatMessage = {
      id: newMessageId(),
      conversationId: proposal.conversationId,
      role: 'system',
      text: '',
      toolCalls: [],
      // 存证卡在对话流的排序键（ChatArea 按消息 createdAt 排序）——继承原提案时间戳，让存证卡
      // 替换活卡时钉在原位（触发它的工具调用之后），而非用决定落定时刻排到流底部。决定时刻记在
      // record.decidedAt。
      createdAt: proposal.createdAt,
      done: true,
      kind: 'proposal',
      refId: proposal.id,
      proposalRecord: record,
    };
    await appendMessage(agentId, proposal.conversationId, msg); // 先落盘
    broadcast({ type: 'chat.proposalRecord', conversationId: proposal.conversationId, message: msg }); // 后广播
  } catch (e) {
    console.warn(`[proposal] 决定存证落盘失败（${proposal.id}）：${String(e)}——决定已生效，仅缺存证`);
  }
}
