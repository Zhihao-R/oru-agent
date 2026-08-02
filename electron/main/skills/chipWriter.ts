/**
 * Skill 模块（v1）chip 落 chat 流的统一入口。
 *
 * 此前 installer.ts / upgrader.ts / manager.ts 三处都有近似的 writeChip 函数——
 * 字段、broadcast、append 调用都一样，差异只在 kind + 文案。抽到一个 helper 后：
 * - 三处的 writer 收敛到一处
 * - chip 字段未来要扩展（如加 metadata）改一处即可
 *
 * 调用方负责构造文案（kind 多语义，不适合放进 helper 黑箱）。
 *
 * payload 用统一 SkillModuleActionPayload —— plugin/skill 七种 kind 共享一个形状。
 */
import type { ChatMessage, SkillModuleActionPayload } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { newMessageId } from '@shared/ids';
import { appendMessageActive } from '../plugins/appendMessage';

type Broadcast = (ev: ServerEvent) => void;
type SkillModuleChipKind =
  | 'plugin-install'
  | 'plugin-update'
  | 'plugin-uninstall'
  | 'plugin-activate'
  | 'skill-create'
  | 'skill-patch'
  | 'skill-install'
  | 'skill-call';

export async function writeSkillModuleChip(args: {
  conversationId: string;
  kind: SkillModuleChipKind;
  text: string;
  payload: SkillModuleActionPayload;
  broadcast: Broadcast;
}): Promise<void> {
  const msg: ChatMessage = {
    id: newMessageId(),
    conversationId: args.conversationId,
    role: 'system',
    text: args.text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    kind: args.kind,
    skillModuleAction: args.payload,
  };
  await appendMessageActive(args.conversationId, msg);
  args.broadcast({ type: 'chat.skillModule', conversationId: args.conversationId, message: msg });
}

/**
 * 写完 plugin 操作 chip 后顺手广播 plugins.state 让拓展页全量刷。
 */
export async function broadcastPluginsState(broadcast: Broadcast): Promise<void> {
  const { listPlugins } = await import('../plugins/registry');
  broadcast({ type: 'plugins.state', plugins: listPlugins() });
}

/** 广播全量 skills（standalone + builtin + plugin 内），跟 skill.list 返回一致 */
export async function broadcastSkillsState(broadcast: Broadcast): Promise<void> {
  const { listStandaloneSkills } = await import('./registry');
  const { listPlugins } = await import('../plugins/registry');
  broadcast({
    type: 'skills.state',
    skills: [...listStandaloneSkills(), ...listPlugins().flatMap((p) => p.skills)],
  });
}
