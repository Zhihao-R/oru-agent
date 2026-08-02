/**
 * 计时器/闹钟表单 ↔ ScheduleSpec 映射（纯函数，多触发规则）。照设计稿「定时触发器」组件模型：
 * 计时器＝时长 h:m 后执行 count 次；闹钟＝时刻 h:m + 星期 + 一直/N 次。底层 kind 不变。
 */
import { describe, it, expect } from 'vitest';
import {
  buildRule,
  describeForm,
  formFromRule,
  defaultForm,
  formValid,
  type SpecForm,
} from '../../src/components/scheduledTask/specForm';

const NOW = new Date(2026, 5, 23, 10, 0, 0).getTime();

describe('buildRule · 计时器（时长）', () => {
  it('count>1 → interval（时长=分钟）+ 强制次数', () => {
    expect(buildRule({ mode: 'timer', h: 0, m: 30, count: 3 }, NOW)).toEqual({
      spec: { kind: 'interval', every: 30, unit: 'minute' },
      stopAfterRuns: 3,
    });
    // 2 小时 30 分 = 150 分钟
    expect(buildRule({ mode: 'timer', h: 2, m: 30, count: 4 }, NOW)).toEqual({
      spec: { kind: 'interval', every: 150, unit: 'minute' },
      stopAfterRuns: 4,
    });
  });
  it('count===1 → once(at = now + 时长)', () => {
    expect(buildRule({ mode: 'timer', h: 0, m: 5, count: 1 }, NOW)).toEqual({
      spec: { kind: 'once', at: NOW + 5 * 60_000 },
    });
    expect(buildRule({ mode: 'timer', h: 2, m: 0, count: 1 }, NOW)).toEqual({
      spec: { kind: 'once', at: NOW + 2 * 3_600_000 },
    });
  });
  it('count===1 带 at（回填的既有 once）→ 保留绝对时刻', () => {
    const at = NOW - 999;
    expect(buildRule({ mode: 'timer', h: 0, m: 5, count: 1, at }, NOW)).toEqual({
      spec: { kind: 'once', at },
    });
  });
});

describe('buildRule · 闹钟（时刻）', () => {
  it('无星期 → daily；forever 无次数', () => {
    expect(
      buildRule({ mode: 'alarm', h: 8, m: 0, days: [], countMode: 'forever', count: 8 }, NOW),
    ).toEqual({ spec: { kind: 'daily', minutesOfDay: 480 } });
  });
  it('有星期 → weekly（后端 weekday 升序）；count 模式带次数', () => {
    expect(
      buildRule({ mode: 'alarm', h: 14, m: 0, days: [3, 1], countMode: 'n', count: 5 }, NOW),
    ).toEqual({ spec: { kind: 'weekly', weekdays: [1, 3], minutesOfDay: 840 }, stopAfterRuns: 5 });
  });
});

describe('formFromRule · 据 spec.kind 判模式', () => {
  it('interval → 计时器（时长拆 h:m，count=stopAfterRuns）', () => {
    expect(formFromRule({ spec: { kind: 'interval', every: 90, unit: 'minute' }, stopAfterRuns: 3 }, NOW)).toMatchObject({
      mode: 'timer',
      h: 1,
      m: 30,
      count: 3,
    });
  });
  it('once → 计时器 count=1：按打开时刻换算剩余时长（打磨 5：曾是占位 0:0），保留 at', () => {
    const at = NOW + 45 * 60_000; // 45 分钟后
    const f = formFromRule({ spec: { kind: 'once', at } }, NOW);
    expect(f).toMatchObject({ mode: 'timer', h: 0, m: 45, count: 1, at });
    expect(formValid(f)).toBe(true); // 显示/校验不再半残
  });
  it('once 不动字段直接保存 → buildRule 保留原触发时刻（不按新时长重算）', () => {
    const at = NOW + 45 * 60_000;
    const f = formFromRule({ spec: { kind: 'once', at } }, NOW);
    expect(buildRule(f, NOW)).toEqual({ spec: { kind: 'once', at } });
  });
  it('once 已过期 → 回落 0:0 + 保存禁用（与现状一致）', () => {
    const f = formFromRule({ spec: { kind: 'once', at: NOW - 60_000 } }, NOW);
    expect(f).toMatchObject({ h: 0, m: 0, count: 1 });
    expect(formValid(f)).toBe(false);
  });
  it('daily → 闹钟 无星期 forever', () => {
    expect(formFromRule({ spec: { kind: 'daily', minutesOfDay: 480 } }, NOW)).toMatchObject({
      mode: 'alarm',
      h: 8,
      m: 0,
      days: [],
      countMode: 'forever',
    });
  });
  it('weekly + stopAfterRuns → 闹钟 count 模式', () => {
    expect(
      formFromRule({ spec: { kind: 'weekly', weekdays: [1], minutesOfDay: 840 }, stopAfterRuns: 4 }, NOW),
    ).toMatchObject({ mode: 'alarm', h: 14, m: 0, days: [1], countMode: 'n', count: 4 });
  });
});

describe('describeForm · onceFrozen 横幅按绝对时刻（打磨 5）', () => {
  it('带 at 的 once：when 取 at 的本地 HH:mm（曾拿占位 h/m 拼出 00:00）', () => {
    const at = new Date(2026, 5, 23, 14, 30, 0).getTime();
    const t = (key: string, params?: Record<string, unknown>) =>
      `${key}:${String(params?.when ?? '')}`;
    expect(describeForm({ mode: 'timer', h: 0, m: 0, count: 1, at }, t)).toBe(
      'scheduledTask:rule.onceFrozen:14:30',
    );
  });
});

describe('往返 formFromRule(buildRule(x)) ≈ x（无损项）', () => {
  const cases: SpecForm[] = [
    { mode: 'timer', h: 0, m: 30, count: 3 },
    { mode: 'timer', h: 2, m: 0, count: 12 },
    { mode: 'alarm', h: 8, m: 0, days: [], countMode: 'forever', count: 8 },
    { mode: 'alarm', h: 16, m: 0, days: [1, 3, 5], countMode: 'n', count: 6 },
  ];
  for (const x of cases) {
    it(JSON.stringify(x), () => {
      expect(formFromRule(buildRule(x, NOW), NOW)).toMatchObject(x);
    });
  }
});

describe('formValid + defaultForm', () => {
  it('计时器时长为 0 → 无效；闹钟恒有效', () => {
    expect(formValid({ mode: 'timer', h: 0, m: 0, count: 1 })).toBe(false);
    expect(formValid({ mode: 'timer', h: 0, m: 1, count: 1 })).toBe(true);
    expect(formValid(defaultForm())).toBe(true);
  });
  it('defaultForm 是每天 08:00', () => {
    expect(buildRule(defaultForm(), NOW)).toEqual({ spec: { kind: 'daily', minutesOfDay: 480 } });
  });
});
