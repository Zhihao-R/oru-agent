/**
 * S29·G90 冲突卡收口③ 的「裁决交回 AI」——冲突卡收起后，把被并行 defer 的 AI 写入连同裁决结果起新轮交回
 * （不等用户再开口）。与 completionAnnounce 同骨架：系统口吻 nudge（不落 user 气泡），空闲起轮 / 忙时排队搭车。
 *
 * 为何不机械放行原写入：多步编辑里后一笔常以前一笔为前提，裁决否掉前一笔后照落后一笔会留半套引用不存在内容的
 * 修改——所以交回 AI 由它基于新的共同起点重新决定续跑还是重写（理想页 workspace Card 详解）。
 *
 * 为何不复用 completionAnnounce（骨架几乎同构）：它对 'task-completed' 做 hasQueuedTrigger 去重，会在该对话已
 * 排着一条后台完成播报时**丢掉**本次裁决 nudge——裁决交回不能被去重掉（丢了 AI 就永不知晓、挂起的写入无声死）。
 * 语义不同故不并骨架（宁可这段循环与它相似，也不引入静默丢裁决的风险）。
 */
import type { Agent, Conversation } from '@shared/types';
import type { ConflictOutcome } from '@shared/protocol';
import { newMessageId } from '@shared/ids';
import type { Broadcast } from '../server';
import { getConversation } from '../../conversations/store';
import { getAgent, listAgents } from '../../agent/store/agents';
import { steeringQueue, steeringKey } from '../../agent/steeringQueue';
import { runAssembledMainTurn } from './mainTurnAssembly';

/**
 * 系统口吻的裁决 nudge（英文 system-trigger prompt，与 buildAnnounceNudge 同款不走 i18n——喂 AI 的 prompt
 * 不翻，只带一句语言提示）。outcome：用户保留了谁的版本 / 手动拼合。
 */
function buildVerdictNudge(path: string, outcome: ConflictOutcome, lang: 'zh' | 'en'): string {
  const verdict =
    outcome === 'mine'
      ? "the user kept THEIR OWN version and discarded yours"
      : outcome === 'theirs'
        ? "the user kept YOUR version"
        : outcome === 'both'
          ? "the user manually merged both versions by hand"
          : "the conflict card was dismissed without a decision (the file was closed or renamed)";
  return (
    `(System trigger: a conflict on "${path}" — where you and the user had edited the same section — has been ` +
    `resolved: ${verdict}. The file's current content on disk is now authoritative. A write of yours to this file ` +
    `was held while the conflict was open; do NOT blindly replay it. Re-read the current content and decide afresh ` +
    `whether to continue, rewrite, or leave it as is. If this conversation has no earlier user message to tell you ` +
    `which language to use, respond in ${lang === 'zh' ? 'Chinese' : 'English'}.)`
  );
}

/**
 * 给被挂起写入的每个对话起一轮交回裁决。convIds 为 clearConflict 取回的对话列表（去重）。
 * agentId 按 active 解析——与 maybeResumeTurn / resolveActiveConversationId 全仓同一约定（Oru 当前单活跃
 * agent，所有系统起轮都据 activeId）。已知限制：若将来多 agent 且裁决时活跃 agent 已换，getConversation
 * 会抛错、该对话静默跳过（与 maybeResumeTurn 同源限制，非本 session 独有）；要根治须把 agentId 随挂起一并记账。
 */
export async function resumeDeferredWritesAfterResolve(opts: {
  convIds: string[];
  path: string;
  outcome: ConflictOutcome;
  lang: 'zh' | 'en';
  broadcast: Broadcast;
}): Promise<void> {
  const { convIds, path, outcome, lang, broadcast } = opts;
  if (convIds.length === 0) return;
  const activeId = (await listAgents()).activeId;
  if (!activeId) return;
  const nudge = buildVerdictNudge(path, outcome, lang);

  for (const conversationId of convIds) {
    const key = steeringKey(activeId, conversationId);
    const decision = await steeringQueue.enqueueOrStart(key, {
      clientMsgId: newMessageId(),
      text: nudge,
      trigger: 'task-completed', // 系统事件 nudge：不落 user 气泡、handback 时 drop（与后台完成播报同族）
    });
    if (decision.action !== 'started') continue; // 忙 → 已入队，回合末搭车
    let agent: Agent;
    let conversation: Conversation;
    try {
      agent = await getAgent(activeId);
      conversation = await getConversation(activeId, conversationId);
    } catch {
      await steeringQueue.handBackIfRunning(key, decision.token); // 取数失败按 token 归属释放刚占的闸（§6）
      continue;
    }
    if (conversation.archivedAt != null) {
      await steeringQueue.handBackIfRunning(key, decision.token); // 归档对话不复活；按归属释放
      continue;
    }
    void runAssembledMainTurn({ agentId: activeId, agent, conversation, broadcast, runToken: decision.token, firstText: nudge });
  }
}
