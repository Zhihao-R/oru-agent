/**
 * 触发规则表单 ↔ ScheduleSpec 映射（纯函数，多触发规则）。照设计稿「定时触发器」组件的心智模型：
 *
 * - 计时器（timer）：时长 h:m 后执行，共 count 次（count===1 = 不重复，一次）。
 * - 闹钟（alarm）：某时刻 h:m + 星期（未选=每天）+ 一直重复 / 共 count 次。
 *
 * 映射到既有 once/daily/weekly/interval——底层 kind 不变、调度内核零改动：
 *   timer count===1        -> once(at = now + 时长)
 *   timer count>1          -> interval(every=时长分钟) + stopAfterRuns=count（强制次数）
 *   alarm 无星期           -> daily(minutesOfDay)          ，一直/count
 *   alarm 有星期           -> weekly(weekdays, minutesOfDay)，一直/count
 *
 * days 直接存后端 weekday 编号（0=周日..6=周六，与 ScheduleSpec.weekly.weekdays 同）。
 * 有损项：timer count===1 回填既有 once 带上 frozen `at`（buildRule 保留、不按 now 重算）。
 */
import type { ScheduleSpec } from '@shared/types';

/** 一条底层规则的入参片段。 */
export type RuleSpec = { spec: ScheduleSpec; stopAfterRuns?: number };

export type SpecForm =
  | { mode: 'timer'; h: number; m: number; count: number; at?: number }
  | { mode: 'alarm'; h: number; m: number; days: number[]; countMode: 'forever' | 'n'; count: number };

/** 界面语言取词器（i18next 风格 t / 主进程 tFor）。 */
type TFn = (key: string, params?: Record<string, unknown>) => string;

/** 闹钟默认：每天 08:00 一直。 */
export function defaultForm(): SpecForm {
  return { mode: 'alarm', h: 8, m: 0, days: [], countMode: 'forever', count: 8 };
}

/** 计时器默认：30 分钟后执行一次。 */
export function defaultTimerForm(): SpecForm {
  return { mode: 'timer', h: 0, m: 30, count: 1 };
}

/** 表单是否可落地（计时器时长须 >0）。 */
export function formValid(f: SpecForm): boolean {
  return f.mode === 'alarm' || f.h * 60 + f.m > 0;
}

export function buildRule(f: SpecForm, nowMs: number): RuleSpec {
  if (f.mode === 'timer') {
    const total = f.h * 60 + f.m; // 分钟
    if (f.count <= 1) {
      // 回填的既有 once 保留绝对时刻；新建则从现在起算
      const at = f.at ?? nowMs + total * 60_000;
      return { spec: { kind: 'once', at } };
    }
    return {
      spec: { kind: 'interval', every: Math.max(1, total), unit: 'minute' },
      stopAfterRuns: Math.max(1, Math.floor(f.count)),
    };
  }
  const minutesOfDay = f.h * 60 + f.m;
  const spec: ScheduleSpec = f.days.length
    ? { kind: 'weekly', weekdays: [...f.days].sort((a, b) => a - b), minutesOfDay }
    : { kind: 'daily', minutesOfDay };
  return f.countMode === 'n' ? { spec, stopAfterRuns: Math.max(1, Math.floor(f.count)) } : { spec };
}

export function formFromRule(rule: RuleSpec, nowMs: number): SpecForm {
  const { spec, stopAfterRuns } = rule;
  switch (spec.kind) {
    case 'interval': {
      const total = spec.unit === 'hour' ? spec.every * 60 : spec.every;
      return { mode: 'timer', h: Math.floor(total / 60), m: total % 60, count: stopAfterRuns ?? 2 };
    }
    case 'once': {
      // 按打开时刻把绝对时刻换算回剩余时长填回 h/m（曾是占位 0:0——显示/校验/预览三处半成品，
      // 走查二批打磨 5）。保留 at：不动字段直接保存则原触发时刻不变（buildRule 的 f.at ?? 分支）；
      // 动了字段 patchTimer 清 at 按新时长重算。已过期回落 0:0 + 保存禁用（与现状一致）。
      const rem = Math.max(0, Math.round((spec.at - nowMs) / 60_000));
      return { mode: 'timer', h: Math.floor(rem / 60), m: rem % 60, count: 1, at: spec.at };
    }
    case 'daily':
      return {
        mode: 'alarm',
        h: Math.floor(spec.minutesOfDay / 60),
        m: spec.minutesOfDay % 60,
        days: [],
        countMode: stopAfterRuns != null ? 'n' : 'forever',
        count: stopAfterRuns ?? 8,
      };
    case 'weekly':
      return {
        mode: 'alarm',
        h: Math.floor(spec.minutesOfDay / 60),
        m: spec.minutesOfDay % 60,
        days: spec.weekdays,
        countMode: stopAfterRuns != null ? 'n' : 'forever',
        count: stopAfterRuns ?? 8,
      };
  }
}

// ─── 摘要文案（清单行 + 预览横幅共用，照设计稿措辞）─────────────────────
// 星期按周一为首列排序展示；后端 weekday 0=周日..6=周六 → 列序 ((d+6)%7)。
const hhmm = (h: number, m: number) => `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

/** 选中的星期短名（周一为首、按列序），如「二、三」——配「每周」前缀成「每周二、三」。 */
export function weekdayNames(days: number[], t: TFn): string {
  const names = t('scheduledTask:weekdaysShort', { returnObjects: true }) as unknown as string[];
  return [...days]
    .sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
    .map((d) => names[d]) // 索引=后端 weekday（0=日..6=六）
    .join(t('common:listSeparator'));
}

/** 一条规则的人话摘要（设计稿措辞）。 */
export function describeForm(f: SpecForm, t: TFn): string {
  if (f.mode === 'timer') {
    // 带冻结 at 的 once：横幅按绝对时刻展示（曾拿占位的 h/m 拼出「已定在 00:00 触发一次」）
    if (f.at != null) {
      const d = new Date(f.at);
      return t('scheduledTask:rule.onceFrozen', { when: hhmm(d.getHours(), d.getMinutes()) });
    }
    const parts: string[] = [];
    if (f.h) parts.push(t('scheduledTask:rule.durHour', { count: f.h }));
    if (f.m) parts.push(t('scheduledTask:rule.durMinute', { count: f.m }));
    const dur = parts.join(' ') || t('scheduledTask:rule.durMinute', { count: 0 });
    return f.count > 1
      ? t('scheduledTask:rule.timerSummaryN', { dur, count: f.count })
      : t('scheduledTask:rule.timerSummaryOnce', { dur });
  }
  const at = hhmm(f.h, f.m);
  const when = f.days.length
    ? t('scheduledTask:rule.weeklyAt', { days: weekdayNames(f.days, t), at })
    : t('scheduledTask:rule.dailyAt', { at });
  const stop =
    f.countMode === 'n'
      ? t('scheduledTask:rule.stopCountN', { count: f.count })
      : t('scheduledTask:rule.stopForeverText');
  return t('scheduledTask:rule.alarmSummary', { when, stop });
}
