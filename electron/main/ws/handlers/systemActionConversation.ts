/**
 * UI 触发的系统动作（plugin/skill 安装等）不带 conversationId 时的落点。
 * 从 shared.ts 按内聚度拆出（D2(a)）。
 */
import { listAgents } from '../../agent/store/agents';
import { createSubConversation } from '../../conversations/store';
import type { Broadcast } from '../server';
import { pushConvState } from './convState';

/**
 * Skill 模块（v1）：UI 触发的 plugin/skill 动作不带 conversationId 时的落点。
 * 主对话已取消——改为每次新建一条对话承接这次系统动作（PRD：干净独立、不污染当前正聊的话题），
 * 并广播 conv.state 让它进列表；随时间它会沉进「更早」收纳区，和别的对话一视同仁。
 *
 * title 用动作本身命名（如「安装插件」）而非默认「新对话」：这些纯系统动作没有聊天回合，
 * 不会触发 autoNameConversation，留默认标题会在侧栏堆出一串同名「新对话」无法分辨。
 * 标题信号本就来自动作自身（已知），直接拿来当名最克制。
 */
export async function resolveActiveConversationId(broadcast: Broadcast, title: string): Promise<string> {
  const { activeId } = await listAgents();
  if (!activeId) throw new Error('找不到 active agent');
  const conv = await createSubConversation(activeId, title);
  await pushConvState(activeId, null, null, broadcast);
  return conv.id;
}
