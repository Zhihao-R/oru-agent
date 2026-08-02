/**
 * 交还分流单源（S08 · G14）——回合因故障或中断异常结束时，未消费队列显式交还用户发落。
 * 前端交还（chat.abort 回执）与崩溃恢复（chat.steering.recovered）两条路径共用同一判定，
 * 避免两侧各写一份漂移。纯函数只看 trigger + origin 两个语义轴，不碰 UI。
 */
import type { TriggerOrigin, TurnTriggerType } from '../types';

/**
 * - 'draft'：桌面用户亲手打的字（trigger==='user' 且无 origin）→ 回填输入框草稿（现状行为）。
 * - 'pending-item'：定时触发（scheduled）或渠道消息（带 origin）→ 列成待处理项（放行 / 清掉）。
 *   渠道消息虽是 user 语义，但没有桌面输入框可回填，故走待处理项。
 * - 'drop'：后台任务完成（task-completed）→ 静默丢弃、不交还给用户。它只是「起一轮播报」的内部
 *   信号，无用户可见对应物；且可再生——任务登记表的 announcedAt 仍为空，下一轮起点的
 *   buildUnannouncedTaskHint 会把它重新带出并播报。交还成待处理项只会让用户看到一条无从判断的
 *   「后台任务完成」条目，还可能引出空播报轮（S09 review · M2）。前端两个 filter 只挑
 *   'draft' / 'pending-item'，'drop' 天然落空、被忽略。
 */
export function handbackForm(m: {
  trigger: TurnTriggerType;
  origin?: TriggerOrigin;
}): 'draft' | 'pending-item' | 'drop' {
  if (m.trigger === 'task-completed') return 'drop';
  return m.trigger === 'user' && !m.origin ? 'draft' : 'pending-item';
}
