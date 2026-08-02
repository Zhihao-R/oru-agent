/**
 * 后台完成 → 统一队列播报的**共享编排骨架**（S09 subagent 任务 / S19 后台命令共用）。
 *
 * 两类完成（subagent 任务、后台命令）走同一条 task-completed 触发通路，播报流程逐字相同：
 *   取会话（已删/归档跳过）→ 可选前置检查 → 取语言拼 nudge → 队列去重 → enqueueOrStart
 *   → 空闲起播报轮（取 agent 失败要释放刚占的闸）/ 忙时排队回合末合并搭车。
 * 差异只在「nudge 文案」与「起播报前是否再 peek 一次」——各调用方注入，骨架不重复。
 */
import type { Agent, Conversation } from '@shared/types';
import { newMessageId } from '@shared/ids';
import type { Broadcast } from '../server';
import { getConversation } from '../../conversations/store';
import { getAgent } from '../../agent/store/agents';
import { getSettings } from '../../projects/store';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { steeringQueue, steeringKey } from '../../agent/steeringQueue';
import { runAssembledMainTurn } from './mainTurnAssembly';

export async function enqueueCompletionAnnounce(opts: {
  agentId: string;
  conversationId: string;
  broadcast: Broadcast;
  /** 系统口吻的播报 nudge（不落 user 气泡）；按对话语言产出，无更早用户消息时回落界面语言 lang。 */
  buildNudge: (lang: 'zh' | 'en') => string;
  /** 起播报前的额外前置检查（返回 false 则不播报）——subagent 侧用它 peek「有没有未播报终态任务」。 */
  precheck?: () => Promise<boolean>;
}): Promise<void> {
  const { agentId, conversationId, broadcast, buildNudge, precheck } = opts;
  // 归档对话不唤醒（归档=已离开，不因后台完成复活）。
  let conversation: Conversation;
  try {
    conversation = await getConversation(agentId, conversationId);
  } catch {
    return; // 对话已删
  }
  if (conversation.archivedAt != null) return;
  if (precheck && !(await precheck())) return;

  // lang / nudge 先取好，让「去重检查 + 入队」尽量贴近、缩小 TOCTOU 窗（去抖窗已把同对话并发隔开，这里只做纵深）。
  const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
  const nudge = buildNudge(lang);

  const key = steeringKey(agentId, conversationId);
  // 去重：已有一条排队的 task-completed，它起回合时 runtime context 会列全部未播报项，无需再入第二条。
  if (steeringQueue.hasQueuedTrigger(key, 'task-completed')) return;

  const decision = await steeringQueue.enqueueOrStart(key, {
    clientMsgId: newMessageId(),
    text: nudge,
    trigger: 'task-completed',
  });
  // 忙时入队（enqueued）：等回合末合并搭车，无 UI 气泡故直接返回。
  if (decision.action !== 'started') return;
  // 空闲 → started：起一轮播报（firstText=nudge 作 userText、不落 history）。
  let agent: Agent;
  try {
    agent = await getAgent(agentId);
  } catch {
    await steeringQueue.handBackIfRunning(key, decision.token); // 取数失败按 token 归属释放刚占的闸（§6）
    return;
  }
  void runAssembledMainTurn({ agentId, agent, conversation, broadcast, runToken: decision.token, firstText: nudge });
}
