/**
 * 事件流空闲看门狗单元测试——多轮 agent 后台调用的统一超时原语。
 * 核心回归：事件持续到达时总时长再长也不杀（旧「总时长硬杀」在积压大的正常运行上误杀）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withIdleWatchdog } from '../../electron/main/agent/util/idleWatchdog';

describe('withIdleWatchdog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** 用 setTimeout 驱动的慢速事件流——配合 fake timers 模拟事件间隔 */
  async function* slowFeed(gaps: number[]): AsyncIterable<number> {
    for (let i = 0; i < gaps.length; i++) {
      await new Promise((r) => setTimeout(r, gaps[i]));
      yield i;
    }
  }

  it('事件持续到达就不杀:间隔各 4 分钟、总时长 12 分钟,onIdle 不触发(回归:旧总时长硬杀会误杀)', async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const FOUR_MIN = 4 * 60_000;
    const received: number[] = [];
    const consume = (async () => {
      for await (const ev of withIdleWatchdog(slowFeed([FOUR_MIN, FOUR_MIN, FOUR_MIN]), 5 * 60_000, onIdle)) {
        received.push(ev);
      }
    })();
    await vi.advanceTimersByTimeAsync(FOUR_MIN * 3 + 1000);
    await consume;
    expect(received).toEqual([0, 1, 2]);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('流静默超过 idleMs → onIdle 触发(卡死才杀)', async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    // 第一个事件 1 分钟后到,之后静默——静默 5 分钟处应触发
    const it2 = withIdleWatchdog(slowFeed([60_000, 60 * 60_000]), 5 * 60_000, onIdle)[Symbol.asyncIterator]();
    const first = it2.next();
    await vi.advanceTimersByTimeAsync(60_000 + 10);
    expect((await first).value).toBe(0);
    const second = it2.next();
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(onIdle).toHaveBeenCalledTimes(1);
    void second; // onIdle 一般接 abort,上游流会随之断掉;这里只验证看门狗触发本身
  });

  it('流正常结束后计时器已清理,不再触发 onIdle', async () => {
    vi.useFakeTimers();
    const onIdle = vi.fn();
    const consume = (async () => {
      for await (const ev of withIdleWatchdog(slowFeed([1000]), 5 * 60_000, onIdle)) void ev;
    })();
    await vi.advanceTimersByTimeAsync(2000);
    await consume;
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});
