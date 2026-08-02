/**
 * 后台 subagent 任务完成 → 统一队列播报（S09 · G69）。编排骨架共享自 completionAnnounce.ts，
 * 本文件只留 subagent 特有的两处：起播报前 peek「有没有未播报终态任务」，与任务口吻的 nudge 文案。
 *
 * 未播报任务清单仍由回合起点 systemContext（buildUnannouncedTaskHint）带出并 markAnnounced 去重。
 * taskAnnouncer 只负责去抖后调本函数（经 index.ts 注入 broadcast）——「去抖层 / 播报编排层」二分。
 */
import type { Broadcast } from '../server';
import { listTasksForConversation } from '../../tasks/store';
import { enqueueCompletionAnnounce } from './completionAnnounce';

/**
 * 后台播报轮的 nudge 文本（系统口吻，告知 Oru 这是后台任务完成的播报轮）——英文工程指令（类③）。
 * 产出语言由系统前缀的 OUTPUT_LANGUAGE_RULE 按对话语言定；唯独本对话无更早用户消息可判时，
 * 条件回落界面语言 `lang`（D4 边界）——不无脑覆盖对话语言。
 */
function buildAnnounceNudge(lang: 'zh' | 'en'): string {
  return (
    '(System trigger: a background task you delegated has finished. Look at the ' +
    '"completed but not yet announced" tasks in your runtime context, briefly announce the ' +
    "result(s) to the user in your own voice, and ask whether to continue or test. Speak proactively; " +
    'if there is nothing left worth reporting, a one-line acknowledgement is fine — do not fabricate. ' +
    'If this conversation has no earlier user message to tell you which language to use, respond in ' +
    `${lang === 'zh' ? 'Chinese' : 'English'}.)`
  );
}

export async function enqueueTaskCompletionAnnounce(
  agentId: string,
  conversationId: string,
  broadcast: Broadcast,
): Promise<void> {
  return enqueueCompletionAnnounce({
    agentId,
    conversationId,
    broadcast,
    buildNudge: buildAnnounceNudge,
    // 无未播报终态任务 → 不起空播报轮（此处只 peek，不 markAnnounced——去重位留给回合内 hint）。
    // interrupted = 启动扫描认出的崩溃遗留（G18）：也算「已结束、该起播报轮知会」。
    precheck: async () => {
      const tasks = await listTasksForConversation(conversationId);
      return tasks.some(
        (t) =>
          (t.status === 'done' || t.status === 'failed' || t.status === 'interrupted') &&
          !t.announcedAt,
      );
    },
  });
}
