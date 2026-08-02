/**
 * 系统例行统一调度内核（G44）——启停成对、防重入、开机补跑三纪律。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSystemRoutine, msUntilHour } from '../../electron/main/runtime/systemRoutine';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('msUntilHour', () => {
  it('同日未过的整点 → 当天', () => {
    const now = new Date(2026, 5, 17, 1, 0, 0).getTime(); // 01:00
    expect(msUntilHour(now, 4)).toBe(3 * 3_600_000); // 到 04:00
  });
  it('已过的整点 → 明天', () => {
    const now = new Date(2026, 5, 17, 5, 0, 0).getTime(); // 05:00
    expect(msUntilHour(now, 4)).toBe(23 * 3_600_000); // 到次日 04:00
  });
});

describe('createSystemRoutine · interval', () => {
  it('runOnStart 开机跑一次，之后每 everyMs 一次；stop 后不再跑', async () => {
    let n = 0;
    const r = createSystemRoutine({
      id: 't',
      trigger: { kind: 'interval', everyMs: 1000 },
      run: async () => void n++,
      runOnStart: true,
    });
    r.start();
    await vi.advanceTimersByTimeAsync(0); // flush 开机补跑
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect(n).toBe(4);
    r.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(n).toBe(4);
    expect(r.isRunning()).toBe(false);
  });

  it('runOnStart 缺省 → 开机不跑，等第一个间隔', async () => {
    let n = 0;
    const r = createSystemRoutine({
      id: 't2',
      trigger: { kind: 'interval', everyMs: 1000 },
      run: async () => void n++,
    });
    r.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(n).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(1);
    r.stop();
  });

  it('防重入：run 未 resolve 时的触发被跳过', async () => {
    let starts = 0;
    let release: (() => void) | null = null;
    const r = createSystemRoutine({
      id: 't3',
      trigger: { kind: 'interval', everyMs: 1000 },
      run: () =>
        new Promise<void>((res) => {
          starts++;
          release = res;
        }),
    });
    r.start();
    await vi.advanceTimersByTimeAsync(1000); // 第一拍开始、卡住
    expect(starts).toBe(1);
    await vi.advanceTimersByTimeAsync(3000); // 三拍过去，仍卡着 → 都被跳过
    expect(starts).toBe(1);
    release?.(); // 放行
    await vi.advanceTimersByTimeAsync(1000); // 下一拍能跑
    expect(starts).toBe(2);
    r.stop();
  });

  it('trigger 手动催一轮（活跃驱动，G27）；与飞行中定时轮重叠时被防重入跳过', async () => {
    let starts = 0;
    let release: (() => void) | null = null;
    const r = createSystemRoutine({
      id: 't-trigger',
      trigger: { kind: 'interval', everyMs: 1000 },
      run: () =>
        new Promise<void>((res) => {
          starts++;
          release = res;
        }),
    });
    r.start();
    // 定时器还没到点，手动催一轮 → 立刻跑
    r.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toBe(1);
    // 上一轮还卡着，再 trigger → 防重入跳过
    r.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toBe(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    // 放行后再 trigger → 能跑
    r.trigger();
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toBe(2);
    r.stop();
  });

  it('start 幂等：重复 start 不叠加定时器', async () => {
    let n = 0;
    const r = createSystemRoutine({
      id: 't4',
      trigger: { kind: 'interval', everyMs: 1000 },
      run: async () => void n++,
    });
    r.start();
    r.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(n).toBe(1); // 只有一个定时器
    r.stop();
  });
});

describe('createSystemRoutine · daily', () => {
  it('到本地整点触发，并重排次日', async () => {
    vi.setSystemTime(new Date(2026, 5, 17, 3, 0, 0)); // 03:00
    let n = 0;
    const r = createSystemRoutine({
      id: 'd',
      trigger: { kind: 'daily', hour: 4 },
      run: async () => void n++,
    });
    r.start();
    await vi.advanceTimersByTimeAsync(3_600_000); // 到 04:00
    expect(n).toBe(1);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000); // 次日 04:00
    expect(n).toBe(2);
    r.stop();
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    expect(n).toBe(2);
  });
});
