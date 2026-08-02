/**
 * 模型面向的「人话时间」→ 机器 ScheduleSpec 换算（纯函数、注入 now）。
 *
 * 第一性：把口语时间换算成机器时间戳是 AI 最不可靠的一类计算（病灶：把「今晚六点」算到 8 天前）。
 * 让模型只说「什么时候」（日期/钟点/星期/相对量），换算交给这里的代码——与手动表单 buildSpec
 * 共用同一套 timeAtoms，单一事实源。越界/缺字段即 throw，message 带填入值供模型重设（见 tech §D）。
 *
 * 工具 inputSchema 是扁平可选字段（JSON Schema 对 union 支持弱），故此处收 RawScheduleArgs
 * 扁平 bag、按 kind 现场校验；下面的类型叙述对应 PRD 的频率表。
 */
import type { ScheduleSpec } from '../types';
import { afterToMs, hhmmToMinutes, parseLocalDateTime, weekdayToNumber, type Weekday } from './timeAtoms';

/** 工具实际收到的扁平参数（全可选，按 kind 校验）。 */
export interface RawScheduleArgs {
  kind?: string;
  date?: string; // once 绝对：'2026-06-29'
  time?: string; // once 绝对 / daily / weekly：'18:00'
  after?: { value?: number; unit?: string }; // once 相对：从现在起
  weekdays?: string[]; // weekly：['mon','wed','fri']
  every?: number; // interval
  unit?: string; // interval：'minute'|'hour'
}

export function resolveSchedule(input: RawScheduleArgs, now: number): ScheduleSpec {
  switch (input.kind) {
    case 'once': {
      const hasAt = input.date != null || input.time != null;
      const hasAfter = input.after != null;
      if (hasAt && hasAfter) {
        throw new Error('一次性任务的时间：date+time 与 after 二选一，不能同时给');
      }
      if (hasAfter) {
        const { value, unit } = input.after!;
        if (value == null || !Number.isFinite(value) || value < 1) {
          throw new Error(`「多久之后」的数量须为 ≥1 的数，收到「${value}」`);
        }
        if (unit !== 'minute' && unit !== 'hour' && unit !== 'day') {
          throw new Error(`「多久之后」的单位须为 minute/hour/day，收到「${unit}」`);
        }
        return { kind: 'once', at: afterToMs(value, unit, now) };
      }
      if (input.date == null || input.time == null) {
        throw new Error('一次性任务需要 date+time（如 2026-06-29 18:00）或 after（如 45 分钟后）');
      }
      return { kind: 'once', at: parseLocalDateTime(input.date, input.time) };
    }

    case 'daily':
      if (input.time == null) throw new Error('每天任务需要 time（如 08:00）');
      return { kind: 'daily', minutesOfDay: hhmmToMinutes(input.time) };

    case 'weekly': {
      if (!Array.isArray(input.weekdays) || input.weekdays.length === 0) {
        throw new Error('每周任务需要至少一个 weekday（如 ["mon","wed","fri"]）');
      }
      if (input.time == null) throw new Error('每周任务需要 time（如 16:00）');
      return {
        kind: 'weekly',
        weekdays: input.weekdays.map((w) => weekdayToNumber(w as Weekday)),
        minutesOfDay: hhmmToMinutes(input.time),
      };
    }

    case 'interval':
      // every≥1 / 不低于最小间隔由下游 validateSpec 把关（单一事实源），此处只确保类型可达
      if (input.every == null || !Number.isFinite(input.every)) {
        throw new Error(`间隔任务需要 every（≥1 的整数），收到「${input.every}」`);
      }
      if (input.unit !== 'minute' && input.unit !== 'hour') {
        throw new Error(`间隔单位须为 minute/hour，收到「${input.unit}」`);
      }
      return { kind: 'interval', every: input.every, unit: input.unit };

    default:
      throw new Error(`未知的频率 kind「${input.kind}」，须为 once/daily/weekly/interval`);
  }
}
