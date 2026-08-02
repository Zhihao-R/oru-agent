/**
 * 后台命令完成 → 统一队列播报（S19·G15）。编排骨架共享自 completionAnnounce.ts，本文件只留后台命令
 * 特有的 nudge 文案。「触发带的是信号，不是全部输出」：nudge 只说「有后台命令结束了，去看」，具体哪条/
 * 退出码由回合起点 hint（buildUnannouncedBackgroundHint）带出，完整输出留后台、模型按需 read_background_output。
 */
import type { Broadcast } from '../server';
import type { BackgroundCommandRecord } from '../../proposals/backgroundCommandStore';
import { enqueueCompletionAnnounce } from './completionAnnounce';

function buildAnnounceNudge(lang: 'zh' | 'en'): string {
  return (
    '(System trigger: a background command you started has finished. Look at the ' +
    '"finished background commands" list in your runtime context, briefly tell the user the ' +
    "outcome (exit code / whether it succeeded) in your own voice; if you need the full output to " +
    'judge, call read_background_output with its task_id. If there is nothing worth reporting, a ' +
    'one-line acknowledgement is fine — do not fabricate. If this conversation has no earlier user ' +
    `message to tell you which language to use, respond in ${lang === 'zh' ? 'Chinese' : 'English'}.)`
  );
}

export async function enqueueBackgroundCompletionAnnounce(
  rec: BackgroundCommandRecord,
  broadcast: Broadcast,
): Promise<void> {
  if (!rec.agentId) return; // 无归属分身（active 取空）——无从入队，静默
  return enqueueCompletionAnnounce({
    agentId: rec.agentId,
    conversationId: rec.conversationId,
    broadcast,
    buildNudge: buildAnnounceNudge,
    // 无 precheck：notifier 是按具体已结束命令逐条调的，本就有可播报内容（具体清单在回合起点 hint）。
  });
}
