/**
 * 定时任务频率的人话描述——主进程与渲染端共用一份（不含 cron 解析，纯展示，故可放 shared）。
 *
 * 文案随界面语言：调用方传 i18next 风格的 t（渲染端传 useTranslation 的 t、主进程传
 * i18n/t.ts 的 tFor(lang)）。键在 scheduledTask:fmt.*；weekday 走 returnObjects 取数组。
 */
import type { ScheduleSpec } from '../types';

/** 取词器——兼容 i18next t / 主进程 tFor(lang)。weekday 数组处局部 cast 取 returnObjects。 */
export type TFn = (key: string, params?: Record<string, unknown>) => string;

export function fmtHHMM(minutesOfDay: number): string {
  const h = Math.floor(minutesOfDay / 60);
  const m = minutesOfDay % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 频率的人话描述（清单/确认卡的「频率」一行）。 */
export function describeSpec(spec: ScheduleSpec, t: TFn): string {
  switch (spec.kind) {
    case 'once':
      return t('scheduledTask:fmt.once');
    case 'daily':
      return t('scheduledTask:fmt.daily', { time: fmtHHMM(spec.minutesOfDay) });
    case 'weekly': {
      const names = t('scheduledTask:fmt.weekday', {
        returnObjects: true,
      } as Record<string, unknown>) as unknown as string[];
      const days = [...spec.weekdays]
        .sort((a, b) => a - b)
        .map((d) => names[d])
        .join(t('common:listSeparator'));
      return t('scheduledTask:fmt.weekly', { days, time: fmtHHMM(spec.minutesOfDay) });
    }
    case 'interval':
      return spec.unit === 'hour'
        ? t('scheduledTask:fmt.intervalHour', { count: spec.every })
        : t('scheduledTask:fmt.intervalMinute', { count: spec.every });
  }
}

/** 频率 + 重复次数的人话（清单频率列、触发事件 block 共用）。一次性不带次数后缀。 */
export function describeFrequency(spec: ScheduleSpec, stopAfterRuns: number | undefined, t: TFn): string {
  if (spec.kind === 'once') return t('scheduledTask:fmt.once');
  const base = describeSpec(spec, t);
  return stopAfterRuns != null ? t('scheduledTask:fmt.withRuns', { base, count: stopAfterRuns }) : base;
}
