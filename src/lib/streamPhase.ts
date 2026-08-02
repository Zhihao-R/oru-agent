import type { ChatMessage } from '@shared/types';

export type StreamPhase =
  | 'thinking'
  | 'tool'
  | 'output'
  | 'retrying'
  | 'aborted'
  | 'errored'
  | 'done';

/**
 * 从 message 推导当前 phase——「一条消息现在算什么态」的唯一编码器（UI 状态行与 store 对账共用）。
 *
 * **优先级**（自上而下）：
 * 1. aborted（用户主动 Stop，盖过任何状态）
 * 2. errored（终态，必须盖过 done，否则 done 一到错误信息消失）
 * 3. done（正常完成）
 * 4. retrying（transport 层重试中）
 * 5. tool / output / thinking（进行中状态）
 *
 * 这跟 PRD 第四节 / 五节定义对齐。
 */
export function derivePhase(msg: ChatMessage): StreamPhase {
  // abortedByUser=用户主动停（运行时态）；interrupted=重载的中断半截（持久化态）。
  // 两者共用"已中断"灰行 + [重试]——重试会按末尾是否有半截决定续跑还是重发。
  if (msg.abortedByUser || msg.interrupted) return 'aborted';
  if (msg.error) return 'errored';
  if (msg.done) return 'done';
  if (msg.retryAttempt && msg.retryAttempt > 0) return 'retrying';
  const runningTool = msg.toolCalls.find((t) => t.status === 'running');
  if (runningTool) return 'tool';
  if (msg.text.length === 0) return 'thinking';
  return 'output';
}

/** 终态 = 回合已结束（无活跃后端流）。done/aborted/errored 三者，其余皆进行中。 */
export function isTerminalPhase(phase: StreamPhase): boolean {
  return phase === 'done' || phase === 'aborted' || phase === 'errored';
}

/**
 * 倒序返回第一条**有资格作为当前回合终态标志**的消息（没有则 null）。
 *
 * 问的不是「谁是末条」，是「哪条消息能证明当前回合结束了」：
 * - 有资格：kind 为 undefined 的正主消息（assistant 回复 / user 发言）、起回合的
 *   scheduled-trigger 与 aside-referent（role user，找到即说明回合在途、判定不清）。
 * - 无资格：全部卡片类（memory-record / git-hint / proposal / subagent …）——回合副产物，
 *   不标志回合结束；scheduled-run-output——后台定时任务的产出（done:true 的 assistant），
 *   落进的承载对话可能正在跑用户的回合，把它当终态会误清忙碌状态。
 *
 * 白名单方向的代价：新增 ChatMessageKind **默认无资格**，需显式评估后加入白名单。
 * 漏判 → 兜底够不到、忙碌不清（会被正常路径 markDone 自愈）；多判 → 回合真在跑时误清
 * （不自愈）。两害相权取白名单。
 */
export function lastTurnTerminusCandidate(list: ChatMessage[]): ChatMessage | null {
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (m.kind === undefined || m.kind === 'scheduled-trigger' || m.kind === 'aside-referent') {
      return m;
    }
  }
  return null;
}
