/**
 * 把"用户拒绝了某个 proposal"作为一条 user 消息落进 conv history（v0.6）。
 *
 * 设计取舍：原本想用 `kind: 'system-event'` + historyAdapter 拼 system block 给 LLM。
 * review 后发现 historyAdapter 不按 user 消息的 kind 过滤；改 role='system' 又被
 * trimEnabled 默认丢弃。最克制的选择：直接以 user role 落盘，文本采用括号系统旁白
 * 格式 `（系统记：…）`——这是 LLM 训练 corpus 里见过的"meta 标记"模式（OOC 注释、
 * 系统旁白等），分身能识别为系统标记而非用户原话。
 *
 * 文本格式必须跟 stableSystemContext 里教 LLM 找的标记**完全一致**，所以导出常量。
 *
 * 只落盘，不 broadcast——UI 渲染时识别这种 `（系统记：…）` 前缀文本会更复杂；
 * 视觉上这条 user 消息会出现在聊天里，**但因为是 user role + 括号格式，看起来
 * 像用户的内心独白旁白，不至于干扰对话流**。多 tab 同步靠下次 history 刷新。
 */
import type { ChatMessage } from '@shared/types';
import { appendMessage } from '../conversations/store';
import { listAgents } from '../agent/store/agents';
import { newMessageId } from '@shared/ids';
import { SYSTEM_NOTE_PREFIX } from '@shared/userTurn';

/** 拒绝模板——mcpPrompt 用同款字符串教 LLM 识别。note 为用户拒绝附言（G02），有则随附。 */
export function formatRejectionNote(proposalId: string, note?: string): string {
  const base = `${SYSTEM_NOTE_PREFIX}用户在 UI 上拒绝了提案 ${proposalId}。不要在下一轮重复 propose 同一个东西，听用户后续说什么。`;
  const trimmed = note?.trim();
  return trimmed ? `${base}用户附言：${trimmed}）` : `${base}）`;
}

/**
 * 写一条"用户拒绝了提案 X"系统旁白消息。
 *
 * 通过 listAgents() 拿 activeId 作为 agentId——MVP 阶段只有一个分身（twin），
 * 多分身场景未来按 proposal.conversationId 反查 agentId 时再细化。
 */
export async function writeRejectionSystemEvent(
  conversationId: string,
  proposalId: string,
  note?: string,
): Promise<void> {
  const { activeId } = await listAgents();
  if (!activeId) return;
  const msg: ChatMessage = {
    id: newMessageId(),
    conversationId,
    role: 'user',
    text: formatRejectionNote(proposalId, note),
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  };
  await appendMessage(activeId, conversationId, msg);
}
