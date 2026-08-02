/**
 * 定时任务的自然语言时刻 / 结果格式化（清单只显示人话，不显示原始时间戳）。
 * 纯函数（非 React），调用时取当前界面语言（同 resolve.ts/formatRelativeTime 先例）。
 */
import type { ScheduledRunRecord, ScheduledTask } from '@shared/types';
import i18n from '@/lib/i18n';

function hhmm(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 相对自然日前缀：今天 / 明天 / 后天 / 昨天 / M月D日。 */
function dayLabel(ts: number, now: number): string {
  const start = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const days = Math.round((start(ts) - start(now)) / 86_400_000);
  if (days === 0) return i18n.t('scheduledTask:format.today');
  if (days === 1) return i18n.t('scheduledTask:format.tomorrow');
  if (days === 2) return i18n.t('scheduledTask:format.afterTomorrow');
  if (days === -1) return i18n.t('scheduledTask:format.yesterday');
  const d = new Date(ts);
  // dateMD 模板只承载"数字组件"日期；月名类语言（如英文 "Jun 5"）英文期要改这里传本地化月份/Date，光换 key 不够
  return i18n.t('scheduledTask:format.dateMD', { month: d.getMonth() + 1, day: d.getDate() });
}

/** 下次触发的人话，如「明天 08:00」；无下次返回空串。 */
export function describeWhen(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null) return '';
  return `${dayLabel(ts, now)} ${hhmm(ts)}`;
}

/**
 * 已结束任务的分组细分（「已结束」筛选下分「已触发 / 未能触发」两组、并给未能触发原因文案）：
 * - triggered：真的触发过（lastRun 非空，含触发后执行失败的）
 * - dismissed：从没触发就结束、且用户对错过的提醒点了「忽略」
 * - expired：从没触发就结束（设定时间已过没赶上）
 *
 * 口径只看 lastRun，**绝不看 runCount**——手动「立即执行」走 countsAsRun:false 只落 lastRun、
 * 不进 runCount，用 runCount 会把手动跑过的任务误判成未触发（tech §E 点名的回归）。
 *
 * 已知假阴性（tech §E，本批接受不修）：fireDueTask 先 patch nextRunAt→null、再 deliver；若 deliver
 * 抛异常（非返回 ok:false），recordRun 不执行 → 留下 nextRunAt==null && lastRun==null，会被判「未能
 * 触发」，但它其实触发了、只是投递崩了。属低概率（deliver 走 steeringQueue 入队，正常返 ok:false 而非抛）。
 */
export function endedKind(
  task: Pick<ScheduledTask, 'lastRun' | 'dismissed'>,
): 'triggered' | 'dismissed' | 'expired' {
  if (task.lastRun != null) return 'triggered';
  return task.dismissed ? 'dismissed' : 'expired';
}

/** 上次执行结果一行：尚未执行 / 今天 08:00 ✓ 成功 / ✗ 失败 / ⏹ 已中止（用户按停，中性）。
 *  只读 lastRun，故 ScheduledTask 与聚合后的 TaskGroup 都可传。 */
export function describeLastRun(task: Pick<ScheduledTask, 'lastRun'>, now: number = Date.now()): string {
  const r = task.lastRun;
  if (!r) return i18n.t('scheduledTask:format.lastRunNever');
  const when = describeWhen(r.at, now);
  const result =
    r.status === 'ok'
      ? i18n.t('scheduledTask:format.resultOk')
      : r.status === 'aborted'
        ? i18n.t('scheduledTask:format.resultAborted')
        : r.error
          ? i18n.t('scheduledTask:format.resultFailedWith', { error: r.error })
          : i18n.t('scheduledTask:format.resultFailed');
  return r.late
    ? i18n.t('scheduledTask:format.lastRunLate', { when, result })
    : i18n.t('scheduledTask:format.lastRun', { when, result });
}

/** 一条运行记录一行（G45 运行记录）：「今天 08:00 · ✓ 成功」，复用上次结果的结果态文案。 */
export function describeRunRecord(rec: ScheduledRunRecord, now: number = Date.now()): string {
  const when = describeWhen(rec.at, now);
  const result =
    rec.status === 'ok'
      ? i18n.t('scheduledTask:format.resultOk')
      : rec.status === 'aborted'
        ? i18n.t('scheduledTask:format.resultAborted')
        : i18n.t('scheduledTask:format.resultFailed');
  return `${when} · ${result}`;
}
