/**
 * Capture subagent 触发器
 *
 * 每条对话记一个抽取游标——map<convId, cursor>。触发检查时从对话历史直接数
 * cursor 之后的「真实用户轮次」（isUserAuthoredMessage），≥ 阈值就跑一次 capture。
 * 轮数不再由写入点手动 +1——真相在历史里，读侧一数即计入，新入口零漏计（①）、
 * 排队/插话消息也自动计入（②）。
 * capture 只抽 cursor 之后的增量对话，抽完把 cursor 推进到已看过的最后一条；
 * 在途期间新攒的轮次，循环回边重数自然补抽，不丢。
 *
 * 游标是进程内存态：重启后从 0 起，首次抽取退化为读全量一次，之后回到增量。
 */
import { runCapture } from './capture';
import { getActiveProjectId } from '../agent/activeProject';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { readHistory } from '../conversations/store';
import { isUserAuthoredMessage } from '@shared/userTurn';

const TURN_THRESHOLD = 3;

// 已抽取覆盖到的最后一条消息 createdAt；缺省 = 0（尚未抽过，读全量）。内存态，重启归 0。
const cursors = new Map<string, number>();
// per-conv 在途集合：同一对话不重入；不同对话各自跑，互不阻塞、不丢记忆
const inFlightConvs = new Set<string>();

/** 数 cursor 之后的真实用户轮次——真相在历史里，失败兜零不炸触发路径（同 capture.ts:56 口径）。 */
async function countUserTurnsSince(agentId: string, convId: string, sinceMs: number): Promise<number> {
  const history = await readHistory(agentId, convId).catch(() => []);
  return history.filter((m) => m.createdAt > sinceMs && isUserAuthoredMessage(m)).length;
}

/**
 * assistant 落盘后调——唯一触发检查时机（runChatAndPersist 成功/中断两路都调，裸调不 await）。
 *
 * projectIdOverride 三态同 runner/hooks：给了 id / 给了 null（明确无项目）/ 不给（回落主聊天单例）。
 * 在这里就把项目定住：runCapture 内部要过读历史、扫记忆库、LLM 往返多个 await，
 * 期间用户完全可能已切走活跃项目，届时再读就会把这段对话的记忆挂到别的项目下。
 */
export function onAssistantMessage(
  agentId: string,
  convId: string,
  projectIdOverride?: string | null,
): void {
  const projectId = projectIdOverride !== undefined ? projectIdOverride : getActiveProjectId();
  void triggerCapture(agentId, convId, projectId).catch((e) =>
    console.warn('[oru.capture] 触发检查失败', e),
  );
}

async function triggerCapture(
  agentId: string,
  convId: string,
  projectId: string | null,
): Promise<void> {
  if (inFlightConvs.has(convId)) return; // 仅挡同一对话重入，不挡别的对话
  inFlightConvs.add(convId);
  try {
    const ownerId = getCurrentOwnerId();
    // 每次迭代读一次游标：计数与抽取共用同一 since，语义无歧义。入闸后才计数（await 回来重读
    // 再判）；阈值判定全仓唯一出现在此。在途期间新攒的轮次，循环回边读推进后的游标自然补抽，不丢。
    for (;;) {
      const since = cursors.get(convId) ?? 0;
      if ((await countUserTurnsSince(agentId, convId, since)) < TURN_THRESHOLD) break;
      const outcome = await runCapture(ownerId, convId, since, projectId);
      // 【终止防护】coveredUntil==null（failed / unparseable / conversation-not-found）时游标不推进，
      // 历史里用户消息还在 → 条件恒真 → 会死循环。这类结局直接退出本轮，下条 assistant 落盘再试。
      if (outcome.coveredUntil == null) break;
      cursors.set(convId, outcome.coveredUntil);
    }
  } finally {
    inFlightConvs.delete(convId);
  }
}

/** 测试用 / shutdown 用 */
export function __resetForTest(): void {
  cursors.clear();
  inFlightConvs.clear();
}
