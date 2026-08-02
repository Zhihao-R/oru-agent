/**
 * 续跑闸——「非用户发起」的主回合入口与其触发判定。
 *
 * startNonUserMainTurn：审批后续跑 / 后台任务完成播报 / [重试] 共用的闸外回合起点（占闸→跑装配）。
 * maybeResumeTurn：审批通过/拒绝后若该会话已无 pending 提案，自动续起一轮让模型消化「系统记」结果。
 * 从 shared.ts 按内聚度拆出（D2(a)）。
 */
import type { Agent, Conversation } from '@shared/types';
import type { Broadcast } from '../server';
import { getAgent, listAgents } from '../../agent/store/agents';
import { getConversation } from '../../conversations/store';
import { steeringQueue, steeringKey } from '../../agent/steeringQueue';
import { runAssembledMainTurn } from './mainTurnAssembly';
import { acquireResume, releaseResume } from '../../proposals/resumeGuard';
import { claimAutoContinue } from '../../agent/autoContinue';
import { countPendingProposals } from '../../proposals/registry';

/** 断线自动接续（S25）时给续写轮带的「正在重试 n/N」提示元数据。 */
export type RetryHint = { attempt: number; maxRetries: number };

/**
 * 起一轮「非用户发起」的主回合——审批后续跑 / 后台任务完成播报 / [重试] 共用的可复用入口（闸外回合）。
 * 不在 UI 留 user 气泡：nudgeText 仅进入回合作 LLM 输入（缺省 undefined = 从 history 续，等同续跑语义），
 * 本函数不 appendMessage。
 *
 * G11 收编：闸外回合也占准入闸——beginDirectTurn 锁内原子占闸（占不到=已有回合，让位 return），
 * 不再靠 isConversationBusy 双检、也不再要求调用方外层自配同步守卫（锁内原子，两个并发调用天然
 * 只有一个赢）。占闸后跑统一回合装配（与 chat.send / 定时投递同源），回合末 concludeTurn 排空期间
 * 入队项——占了闸的回合必须负责清队。maybeResumeTurn 的 acquireResume 保留，它挡的是另一层
 * 「重复触发续跑」。
 */
export async function startNonUserMainTurn(p: {
  agentId: string;
  conversationId: string;
  broadcast: Broadcast;
  /** 拼进该轮动态 system 段的额外指令（不落 history、不进显示）。 */
  extraDynamicSystemPrompt?: string;
  /** 该轮触发文本（系统口吻，不持久化为 user 气泡）。缺省 undefined=从 history 续（续跑语义）。 */
  nudgeText?: string;
  /** 断线自动接续（S25）：本轮是自动续写，起回合即广播「正在重试 n/N」提示（chat.retrying）。 */
  retryHint?: RetryHint;
}): Promise<void> {
  const key = steeringKey(p.agentId, p.conversationId);
  // 占闸失败 = 已有回合在跑，主动让位（对齐旧 isConversationBusy 早退语义，但改由锁内原子裁决）。
  const token = await steeringQueue.beginDirectTurn(key);
  if (token == null) return;
  // 断线自动接续：真正占到闸、要起跑续写轮了才消费预算（M2：调度被并发抢轮跳过则不白扣）。
  if (p.retryHint) claimAutoContinue(p.conversationId);
  let agent: Agent;
  let conversation: Conversation;
  try {
    agent = await getAgent(p.agentId);
    conversation = await getConversation(p.agentId, p.conversationId);
  } catch (e) {
    // 取数失败必须释放刚占的闸，否则对话永久卡「运行中」、后续 send 全被当 steering 入队永不起回合
    // ——按 token 归属释放（§6），不误清 await 间隙里可能已起的新回合。
    await steeringQueue.handBackIfRunning(key, token);
    throw e;
  }
  await runAssembledMainTurn({
    agentId: p.agentId,
    agent,
    conversation,
    broadcast: p.broadcast,
    runToken: token,
    firstText: p.nudgeText,
    extraDynamicSystemPrompt: p.extraDynamicSystemPrompt,
    retryHint: p.retryHint,
  });
}

/**
 * 审批通过/拒绝后：若该会话已无 pending 提案（整批处理完），自动续起这一轮，让模型带着
 * 「系统记」结果接着干（决策 5）。一对话只续一轮：
 * - acquireResume 同步守卫挡并发双触发（两条命令几乎同时跑完都判到"无 pending"）；
 * - isConversationBusy 挡与用户手动消息抢轮（占位后所有早退都经 finally release，杜绝死锁）。
 *
 * 触发面：只挂在 proposal.execute / proposal.reject 两条**手动审批**路径；信任模式自动执行那条
 * 不挂（turn 未结束）。bash 是主目标（执行结果落「系统记」、模型确有新东西要消化）；mcp/file.write
 * 等手动审批提案恰好也走这两条路径而一并续跑——对它们续跑是否同样必要尚未单独验证，当前按"处理完
 * 提案就叫醒模型"一视同仁，未见害处，如发现某类型不该续再按 kind 收窄。
 */
export async function maybeResumeTurn(
  conversationId: string,
  broadcast: Broadcast,
  explicitAgentId?: string,
  retryHint?: RetryHint,
): Promise<void> {
  if (!acquireResume(conversationId, countPendingProposals(conversationId))) return;
  try {
    // [重试] 续跑传 explicitAgentId（honor 协议里的 agentId，与 chat.send/abort 一致）；
    // 审批后自动续跑不传，回退到 active agent。
    const activeId = explicitAgentId ?? (await listAgents()).activeId;
    if (!activeId) return;
    await startNonUserMainTurn({ agentId: activeId, conversationId, broadcast, nudgeText: undefined, retryHint });
  } finally {
    releaseResume(conversationId);
  }
}
