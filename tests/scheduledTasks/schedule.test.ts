/**
 * 定时任务调度纯函数回归（无副作用、注入时钟，期望值精确相等）
 *
 * 对应技术设计「九、测试约定」纯函数单测 1/2/3/3b/3c：
 * - computeNextRun / advanceNextRun：每日跨午夜、每周多选取最近、interval 从 createdAt 网格推进、once
 * - interval 编辑重算（C1）：换 every 后落在以 createdAt 为原点的新网格、不立即补历史点
 * - collapseMissedToLatest：关机跨多天只补一次（坍缩到最近一个 ≤ now 的触发点，advance 不重复）
 * - validateSpec：低于 MIN_INTERVAL / 结构非法必 throw，边界值通过
 * - describeFrequency：一次性 / 含「共 N 次」
 *
 * 时间一律用本地 Date 构造，不写死时间戳——随运行机器时区自洽。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createInstance } from 'i18next';
import { resources, defaultNS, fallbackLng } from '@shared/i18n/resources';
import type { ScheduleSpec, ScheduledTask } from '@shared/types';

// describeSpec/Frequency 现接界面语言取词器——这里固定中文，验中文频率人话不变。
let tt: (key: string, params?: Record<string, unknown>) => string;
beforeAll(async () => {
  const i = createInstance();
  await i.init({ resources, lng: 'zh', fallbackLng, defaultNS, interpolation: { escapeValue: false } });
  tt = (k, p) => i.t(k, p);
});
import {
  MIN_INTERVAL_MS,
  computeNextRun,
  advanceNextRun,
  collapseMissedToLatest,
  validateSpec,
  describeSpec,
  describeFrequency,
  previewNextRuns,
  assertCreatable,
} from '../../electron/main/scheduledTasks/schedule';

/** 本地时间戳构造（month 0-indexed；June = 5） */
const T = (y: number, mo: number, d: number, h: number, mi = 0) =>
  new Date(y, mo, d, h, mi, 0, 0).getTime();

const MINS = (h: number, m = 0) => h * 60 + m;

// computeNextRun 第三参 createdAt 仅 interval 用；非 interval 传 0 即可。
const ANY = 0;

describe('computeNextRun · daily', () => {
  it('当天未到点 → 当天该时刻', () => {
    const spec: ScheduleSpec = { kind: 'daily', minutesOfDay: MINS(8) };
    expect(computeNextRun(spec, T(2026, 5, 23, 7, 0), ANY)).toBe(T(2026, 5, 23, 8, 0));
  });
  it('当天已过点 → 次日（跨午夜）', () => {
    const spec: ScheduleSpec = { kind: 'daily', minutesOfDay: MINS(8) };
    expect(computeNextRun(spec, T(2026, 5, 23, 10, 0), ANY)).toBe(T(2026, 5, 24, 8, 0));
    expect(computeNextRun(spec, T(2026, 5, 23, 23, 30), ANY)).toBe(T(2026, 5, 24, 8, 0));
  });
  it('恰好等于触发时刻 → 取严格大于的下一个（次日）', () => {
    const spec: ScheduleSpec = { kind: 'daily', minutesOfDay: MINS(8) };
    expect(computeNextRun(spec, T(2026, 5, 23, 8, 0), ANY)).toBe(T(2026, 5, 24, 8, 0));
  });
});

describe('computeNextRun · weekly', () => {
  // 2026-06-23 是周二（getDay()===2）
  it('多选日取最近的下一个（本周稍后的那天）', () => {
    const spec: ScheduleSpec = { kind: 'weekly', weekdays: [1, 3, 5], minutesOfDay: MINS(16) };
    expect(computeNextRun(spec, T(2026, 5, 23, 17, 0), ANY)).toBe(T(2026, 5, 24, 16, 0));
  });
  it('当天是选中日且未到点 → 当天', () => {
    const spec: ScheduleSpec = { kind: 'weekly', weekdays: [1, 3, 5], minutesOfDay: MINS(16) };
    expect(computeNextRun(spec, T(2026, 5, 24, 15, 0), ANY)).toBe(T(2026, 5, 24, 16, 0));
  });
  it('单选日、本周已过 → 下周', () => {
    const spec: ScheduleSpec = { kind: 'weekly', weekdays: [5], minutesOfDay: MINS(16) };
    expect(computeNextRun(spec, T(2026, 5, 26, 17, 0), ANY)).toBe(T(2026, 6, 3, 16, 0));
  });
});

describe('computeNextRun · interval（从 createdAt 起算的等差网格）', () => {
  it('分钟级：从 createdAt 起每 every 分钟，严格大于 after 的下一个', () => {
    const spec: ScheduleSpec = { kind: 'interval', every: 3, unit: 'minute' };
    const ct = T(2026, 5, 23, 14, 0);
    // after = createdAt → 首个网格点 14:03
    expect(computeNextRun(spec, ct, ct)).toBe(T(2026, 5, 23, 14, 3));
    // after = 14:04 → 14:06
    expect(computeNextRun(spec, T(2026, 5, 23, 14, 4), ct)).toBe(T(2026, 5, 23, 14, 6));
  });
  it('小时级：网格点是 createdAt + k 小时（不做整点对齐）', () => {
    const spec: ScheduleSpec = { kind: 'interval', every: 2, unit: 'hour' };
    const ct = T(2026, 5, 23, 14, 23); // 故意带分钟，验证不对齐整点
    expect(computeNextRun(spec, T(2026, 5, 23, 14, 30), ct)).toBe(T(2026, 5, 23, 16, 23));
    expect(computeNextRun(spec, T(2026, 5, 23, 16, 23), ct)).toBe(T(2026, 5, 23, 18, 23));
  });
  it('编辑改 every（C1）：仍以原 createdAt 为网格原点，落新网格且严格大于 now、不补历史点', () => {
    const ct = T(2026, 5, 23, 14, 0);
    const after = T(2026, 5, 23, 23, 0); // 远晚于 createdAt（9h 后）
    const spec1h: ScheduleSpec = { kind: 'interval', every: 1, unit: 'hour' };
    const next = computeNextRun(spec1h, after, ct);
    expect(next).toBe(T(2026, 5, 24, 0, 0)); // 14:00 + 10h，落新 1h 网格、> now
    expect(next).toBeGreaterThan(after);
    expect((next! - ct) % (3_600_000)).toBe(0); // 确在以 createdAt 为原点的网格上
  });
});

describe('computeNextRun · once', () => {
  it('未到点 → 该时刻；已过 → null', () => {
    const at = T(2026, 5, 24, 10, 0);
    expect(computeNextRun({ kind: 'once', at }, T(2026, 5, 23, 0, 0), ANY)).toBe(at);
    expect(computeNextRun({ kind: 'once', at }, T(2026, 5, 24, 11, 0), ANY)).toBeNull();
  });
});

describe('advanceNextRun · 停止条件', () => {
  const base = (
    over: Partial<ScheduledTask>,
  ): Pick<ScheduledTask, 'spec' | 'runCount' | 'stopAfterRuns' | 'enabled' | 'createdAt'> => ({
    spec: { kind: 'daily', minutesOfDay: MINS(8) },
    runCount: 0,
    enabled: true,
    createdAt: T(2026, 5, 1, 0, 0),
    ...over,
  });

  it('一次 fire（countsAsRun 默认 true）→ nextRunAt null + 停用', () => {
    const r = advanceNextRun(base({ spec: { kind: 'once', at: T(2026, 5, 24, 10, 0) } }), T(2026, 5, 24, 10, 1));
    expect(r).toEqual({ nextRunAt: null, enabled: false });
  });

  it('一次 reconcile 补漏（countsAsRun:false）→ nextRunAt null 但保留 enabled（待用户决定）', () => {
    const r = advanceNextRun(
      base({ spec: { kind: 'once', at: T(2026, 5, 24, 10, 0) }, enabled: true }),
      T(2026, 5, 25, 10, 0),
      { countsAsRun: false },
    );
    expect(r).toEqual({ nextRunAt: null, enabled: true });
  });

  it('stopAfterRuns=3：第 3 次 fire（runCount=2）后停（enabled=false, nextRunAt=null）', () => {
    const r = advanceNextRun(base({ runCount: 2, stopAfterRuns: 3 }), T(2026, 5, 23, 8, 0));
    expect(r).toEqual({ nextRunAt: null, enabled: false });
  });

  it('stopAfterRuns=3：第 2 次 fire（runCount=1）→ 继续排程', () => {
    const r = advanceNextRun(base({ runCount: 1, stopAfterRuns: 3 }), T(2026, 5, 23, 8, 0));
    expect(r).toEqual({ nextRunAt: T(2026, 5, 24, 8, 0), enabled: true });
  });

  it('手动/补执行（countsAsRun:false）：不计入 stopAfterRuns 配额', () => {
    const r = advanceNextRun(
      base({ runCount: 2, stopAfterRuns: 3 }),
      T(2026, 5, 23, 8, 0),
      { countsAsRun: false },
    );
    expect(r).toEqual({ nextRunAt: T(2026, 5, 24, 8, 0), enabled: true });
  });
});

describe('collapseMissedToLatest · 只补一次', () => {
  it('关机跨 2 天的每日任务 → 坍缩到最近一个 ≤ now 的触发点（不堆叠）', () => {
    const spec: ScheduleSpec = { kind: 'daily', minutesOfDay: MINS(8) };
    const now = T(2026, 5, 25, 12, 0);
    const missed = collapseMissedToLatest({ spec, nextRunAt: T(2026, 5, 23, 8, 0), createdAt: ANY }, now);
    expect(missed).toBe(T(2026, 5, 25, 8, 0)); // 最近一次（今天 08:00）
    const next = computeNextRun(spec, now, ANY);
    expect(next).toBe(T(2026, 5, 26, 8, 0));
    expect(next).toBeGreaterThan(missed);
  });

  it('interval：坍缩到最近一个 ≤ now 的 createdAt 网格点', () => {
    const spec: ScheduleSpec = { kind: 'interval', every: 2, unit: 'hour' };
    const ct = T(2026, 5, 23, 14, 0);
    const now = T(2026, 5, 23, 21, 0);
    const missed = collapseMissedToLatest({ spec, nextRunAt: T(2026, 5, 23, 16, 0), createdAt: ct }, now);
    expect(missed).toBe(T(2026, 5, 23, 20, 0)); // 14+2k ≤ 21 的最大者
  });

  it('一次 → 返回原定时刻', () => {
    const at = T(2026, 5, 23, 10, 0);
    expect(
      collapseMissedToLatest({ spec: { kind: 'once', at }, nextRunAt: at, createdAt: ANY }, T(2026, 5, 25, 0, 0)),
    ).toBe(at);
  });
});

describe('validateSpec · 护栏与结构', () => {
  it('interval every:1 unit:minute（=60s）通过，every:0 / 负数 throw', () => {
    expect(() => validateSpec({ kind: 'interval', every: 1, unit: 'minute' })).not.toThrow();
    expect(() => validateSpec({ kind: 'interval', every: 1, unit: 'hour' })).not.toThrow();
    expect(() => validateSpec({ kind: 'interval', every: 0, unit: 'minute' })).toThrow();
    expect(() => validateSpec({ kind: 'interval', every: -1, unit: 'hour' })).toThrow();
  });
  it('MIN_INTERVAL = 60s', () => {
    expect(MIN_INTERVAL_MS).toBe(60_000);
  });
  it('weekly 空选日 / 越界日 throw', () => {
    expect(() => validateSpec({ kind: 'weekly', weekdays: [], minutesOfDay: MINS(8) })).toThrow();
    expect(() => validateSpec({ kind: 'weekly', weekdays: [7], minutesOfDay: MINS(8) })).toThrow();
  });
  it('daily minutesOfDay 边界：1439 通过、1440 throw、负数 throw', () => {
    expect(() => validateSpec({ kind: 'daily', minutesOfDay: 1439 })).not.toThrow();
    expect(() => validateSpec({ kind: 'daily', minutesOfDay: 1440 })).toThrow();
    expect(() => validateSpec({ kind: 'daily', minutesOfDay: -1 })).toThrow();
  });
  it('once 合法时间戳通过', () => {
    expect(() => validateSpec({ kind: 'once', at: T(2026, 5, 24, 10, 0) })).not.toThrow();
  });
});

describe('describeSpec · 频率人话', () => {
  it('每天 / 每周多选 / 间隔（分钟·小时）/ 一次性', () => {
    expect(describeSpec({ kind: 'daily', minutesOfDay: MINS(8) }, tt)).toBe('每天 08:00');
    expect(describeSpec({ kind: 'weekly', weekdays: [1, 3, 5], minutesOfDay: MINS(16) }, tt)).toBe(
      '每周一、周三、周五 16:00',
    );
    expect(describeSpec({ kind: 'interval', every: 3, unit: 'minute' }, tt)).toBe('每隔 3 分钟');
    expect(describeSpec({ kind: 'interval', every: 2, unit: 'hour' }, tt)).toBe('每隔 2 小时');
    expect(describeSpec({ kind: 'once', at: T(2026, 5, 24, 10, 0) }, tt)).toBe('一次性');
  });
});

describe('describeFrequency · 含重复次数', () => {
  it('once → 一次性；周期不设次数 → 无后缀；设次数 → 含「共 N 次」', () => {
    expect(describeFrequency({ kind: 'once', at: T(2026, 5, 24, 10, 0) }, undefined, tt)).toBe('一次性');
    expect(describeFrequency({ kind: 'daily', minutesOfDay: MINS(8) }, undefined, tt)).toBe('每天 08:00');
    expect(describeFrequency({ kind: 'interval', every: 3, unit: 'minute' }, 3, tt)).toBe('每隔 3 分钟，共 3 次');
  });
});

describe('previewNextRuns · 接下来三次', () => {
  it('返回严格递增的 N 个未来触发时刻（daily）', () => {
    const spec: ScheduleSpec = { kind: 'daily', minutesOfDay: MINS(8) };
    const runs = previewNextRuns(spec, T(2026, 5, 23, 10, 0), 3, ANY);
    expect(runs).toEqual([T(2026, 5, 24, 8, 0), T(2026, 5, 25, 8, 0), T(2026, 5, 26, 8, 0)]);
  });
  it('interval 从 createdAt 网格预览', () => {
    const spec: ScheduleSpec = { kind: 'interval', every: 2, unit: 'hour' };
    const ct = T(2026, 5, 23, 14, 0);
    expect(previewNextRuns(spec, T(2026, 5, 23, 14, 30), 3, ct)).toEqual([
      T(2026, 5, 23, 16, 0),
      T(2026, 5, 23, 18, 0),
      T(2026, 5, 23, 20, 0),
    ]);
  });
  it('一次性只有一个，之后无', () => {
    const at = T(2026, 5, 24, 10, 0);
    expect(previewNextRuns({ kind: 'once', at }, T(2026, 5, 23, 0, 0), 3, ANY)).toEqual([at]);
  });
});

describe('assertCreatable · 未来时刻闸（兜底，独立于 validateSpec）', () => {
  const NOW = T(2026, 5, 29, 14, 45);
  it('过去的 once → throw（一出生就已结束的提醒被挡下）', () => {
    expect(() => assertCreatable({ kind: 'once', at: T(2026, 5, 21, 18, 0) }, NOW)).toThrow();
  });
  it('= now 的 once（边界）→ throw（须严格未来）', () => {
    expect(() => assertCreatable({ kind: 'once', at: NOW }, NOW)).toThrow();
  });
  it('未来的 once → 放行', () => {
    expect(() => assertCreatable({ kind: 'once', at: T(2026, 5, 29, 18, 0) }, NOW)).not.toThrow();
  });
  it('周期任务（daily/weekly/interval）一律放行（它们有未来触发点）', () => {
    expect(() => assertCreatable({ kind: 'daily', minutesOfDay: 480 }, NOW)).not.toThrow();
    expect(() => assertCreatable({ kind: 'weekly', weekdays: [1], minutesOfDay: 480 }, NOW)).not.toThrow();
    expect(() => assertCreatable({ kind: 'interval', every: 3, unit: 'hour' }, NOW)).not.toThrow();
  });
  it('throw message 含填入时刻 + 当前时间（D：可重设）', () => {
    expect(() => assertCreatable({ kind: 'once', at: T(2026, 5, 21, 18, 0) }, NOW)).toThrow(/2026-06-21 18:00/);
    expect(() => assertCreatable({ kind: 'once', at: T(2026, 5, 21, 18, 0) }, NOW)).toThrow(/2026-06-29 14:45/);
  });
});
