/**
 * resolveSchedule：模型说的「人话时间」（扁平 bag）→ 机器 ScheduleSpec（注入 now、纯函数）。
 *
 * 这是把模型从「自行心算时间戳」里解放出来的核心换算。覆盖五种 kind、两条 once 路径，
 * 以及关键回归：越界日期/时间必须 throw（经 timeAtoms 严格解析），绝不静默翻滚。
 */
import { describe, it, expect } from 'vitest';
import { resolveSchedule } from '@shared/scheduledTasks/resolveSchedule';

const NOW = new Date(2026, 5, 29, 14, 45, 0, 0).getTime(); // 2026-06-29 14:45 本地

describe('resolveSchedule · once', () => {
  it('date + time → at = 本地该时刻', () => {
    expect(resolveSchedule({ kind: 'once', date: '2026-06-29', time: '18:00' }, NOW)).toEqual({
      kind: 'once',
      at: new Date(2026, 5, 29, 18, 0, 0, 0).getTime(),
    });
  });
  it('after 分钟 / 小时 / 天', () => {
    expect(resolveSchedule({ kind: 'once', after: { value: 45, unit: 'minute' } }, NOW)).toEqual({
      kind: 'once',
      at: NOW + 45 * 60_000,
    });
    expect(resolveSchedule({ kind: 'once', after: { value: 2, unit: 'hour' } }, NOW)).toEqual({
      kind: 'once',
      at: NOW + 2 * 3_600_000,
    });
    const d = new Date(NOW);
    expect(resolveSchedule({ kind: 'once', after: { value: 3, unit: 'day' } }, NOW)).toEqual({
      kind: 'once',
      at: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3, d.getHours(), d.getMinutes(), 0, 0).getTime(),
    });
  });
  it('after value:0 throw（否则会被 assertCreatable 当「已过去」误报）', () => {
    expect(() => resolveSchedule({ kind: 'once', after: { value: 0, unit: 'minute' } }, NOW)).toThrow();
  });
  it('date+time 与 after 同时给 → throw', () => {
    expect(() =>
      resolveSchedule({ kind: 'once', date: '2026-06-29', time: '18:00', after: { value: 1, unit: 'hour' } }, NOW),
    ).toThrow();
  });
  it('两路都不给 → throw', () => {
    expect(() => resolveSchedule({ kind: 'once' }, NOW)).toThrow();
  });
  it('关键回归：越界日期 2026-13-05 throw、越界时间 25:00 throw', () => {
    expect(() => resolveSchedule({ kind: 'once', date: '2026-13-05', time: '18:00' }, NOW)).toThrow();
    expect(() => resolveSchedule({ kind: 'once', date: '2026-06-29', time: '25:00' }, NOW)).toThrow();
  });
  it('throw message 含模型填入的值（D：可重设）', () => {
    expect(() => resolveSchedule({ kind: 'once', date: '2026-13-05', time: '18:00' }, NOW)).toThrow(/2026-13-05/);
  });
});

describe('resolveSchedule · daily / weekly / interval', () => {
  it('daily：time → minutesOfDay', () => {
    expect(resolveSchedule({ kind: 'daily', time: '08:00' }, NOW)).toEqual({ kind: 'daily', minutesOfDay: 480 });
  });
  it('weekly：weekday 名 → 数字 + time', () => {
    expect(resolveSchedule({ kind: 'weekly', weekdays: ['mon', 'wed', 'fri'], time: '16:00' }, NOW)).toEqual({
      kind: 'weekly',
      weekdays: [1, 3, 5],
      minutesOfDay: 960,
    });
  });
  it('weekly：空 weekdays throw', () => {
    expect(() => resolveSchedule({ kind: 'weekly', weekdays: [], time: '16:00' }, NOW)).toThrow();
  });
  it('interval：every + unit 原样透传', () => {
    expect(resolveSchedule({ kind: 'interval', every: 3, unit: 'hour' }, NOW)).toEqual({
      kind: 'interval',
      every: 3,
      unit: 'hour',
    });
  });
  it('未知 kind throw', () => {
    expect(() => resolveSchedule({ kind: 'monthly' } as never, NOW)).toThrow();
  });
});
