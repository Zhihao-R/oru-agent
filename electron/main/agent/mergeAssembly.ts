/**
 * 回合末合并的装配标注（S09 · G70）——多条积压输入在回合末被 concludeTurn 合并成下一轮时，
 * 给模型一段「本轮新输入共 N 条 + 按类型分角色」的系统旁白，让它分清哪些是用户补的话、
 * 哪些是系统触发（定时 / 后台完成），别把机器触发当成用户亲口说的。
 *
 * 为什么需要它：restart 批里的 user 项落盘成普通 user 消息、机器触发项各带自身 kind，
 * 但模型 replay 历史时都是 user role——无角色框定就会把「后台任务完成」误当用户指令。
 * 本 notice 作为 restart 轮的 extraDynamicSystemPrompt 注入（不落 history、不上屏）。
 *
 * task-completed 项特殊：它**不落气泡**（无对应历史消息），其播报指令只能经本 notice 到达
 * 模型——故把它随附的 nudge 文本一并带出。
 */
import type { SteeringMsg } from './steeringQueue';

/**
 * 为一批被合并进同一回合的 steering 项装配系统旁白；单条纯 user/scheduled 的平凡续跑返回
 * undefined（无需标注——它已在历史里以正确形态呈现）。含 task-completed 或多条时才产出。
 */
export function buildMergeAssemblyNotice(batch: SteeringMsg[]): string | undefined {
  const taskCompleted = batch.filter((m) => m.trigger === 'task-completed');
  // 单条且非后台完成：历史里已是正确形态（用户消息 / 触发卡），无需额外框定。
  if (batch.length <= 1 && taskCompleted.length === 0) return undefined;

  const users = batch.filter((m) => m.trigger === 'user');
  const scheduled = batch.filter((m) => m.trigger === 'scheduled');

  const lines: string[] = [
    `[本轮新输入共 ${batch.length} 条]`,
    '（这些是你上一轮结束时积压待处理的输入，已按到达顺序合并到这一轮一起处理。' +
      '请分清各自来源，别把系统触发当成用户亲口说的话。）',
  ];
  if (users.length > 0) {
    lines.push(`· 用户补充 ${users.length} 条（上方对话里的用户消息，是用户在你干活期间补的话）`);
  }
  if (scheduled.length > 0) {
    lines.push(`· 定时任务触发 ${scheduled.length} 条（上方触发卡，到点自动触发、非用户手动发起）`);
  }
  if (taskCompleted.length > 0) {
    lines.push(`· 后台任务已完成 ${taskCompleted.length} 项（系统触发的播报，非用户发言）`);
    // task-completed 不落气泡：播报指令只经本 notice 到达模型，取其一条随附（同批指令相同）。
    const nudge = taskCompleted[0].text?.trim();
    if (nudge) lines.push('', nudge);
  }
  return lines.join('\n');
}
