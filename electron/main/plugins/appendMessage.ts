/**
 * Skill 模块（v1）：从 conversationId 反查 agentId 并落盘 chip 消息。
 *
 * 现有 conversations/store.appendMessage 要 (agentId, convId) 双入参——提案执行路径
 * 拿到的是 proposal.conversationId（无 agentId 字段，因为 proposal 自身不绑 agent）。
 * 本 helper 遍历 agents 找匹配 convId 的 agent，然后调底层 appendMessage。
 *
 * MVP 单 agent 时几乎是 O(1)；多 agent 时仍 O(agents × 一次 index 读)，可接受。
 */
import type { ChatMessage } from '@shared/types';
import { listAgents } from '../agent/store/agents';
import { listConversations, appendMessage } from '../conversations/store';

/** 反查 agent → 返回 agentId 或 null（找不到时） */
export async function findAgentForConversation(conversationId: string): Promise<string | null> {
  const { agents } = await listAgents();
  for (const agent of agents) {
    const list = await listConversations(agent.id);
    if (list.some((c) => c.id === conversationId)) return agent.id;
  }
  return null;
}

/** 写一条 chip 到 active conversation；找不到 agent 时 warn 不抛 */
export async function appendMessageActive(
  conversationId: string,
  msg: ChatMessage,
): Promise<void> {
  const agentId = await findAgentForConversation(conversationId);
  if (!agentId) {
    console.warn(
      `[oru.skills] 找不到 conversation ${conversationId} 所属 agent，chip 丢弃: ${msg.text}`,
    );
    return;
  }
  await appendMessage(agentId, conversationId, msg);
}
