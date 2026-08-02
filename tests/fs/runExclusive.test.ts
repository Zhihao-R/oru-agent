/**
 * runExclusive 单测——按 key 串行化任务链：
 *  - 同 key 并发 RMW（读-加-写共享计数器）串行累加，无丢更新
 *  - 不同 key 并发互不阻塞（两条链能同时处于进行中）
 *  - 链上某任务抛错不拖垮同 key 后续任务（错误正常透传给各自 caller）
 *  - 任务自身返回值正常透传
 */
import { describe, expect, it } from 'vitest';
import { runExclusive } from '../../electron/main/fs/runExclusive';

// 让出一次 event loop，制造"读后写前"的交错窗口
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('runExclusive', () => {
  it('同 key 并发 read-modify-write 串行累加，无丢更新', async () => {
    let counter = 0;
    const bump = () =>
      runExclusive('k', async () => {
        const read = counter; // 读
        await tick(); // 交错窗口：若非串行，第二个会读到同样的旧值
        counter = read + 1; // 写
      });

    await Promise.all([bump(), bump(), bump()]);
    expect(counter).toBe(3); // 串行则 0→1→2→3；交错则会丢更新（<3）
  });

  it('不同 key 并发互不阻塞（两条链同时进行中）', async () => {
    let aRunning = false;
    let bSawAConcurrent = false;

    const a = runExclusive('a', async () => {
      aRunning = true;
      await tick();
      await tick();
      aRunning = false;
    });
    const b = runExclusive('b', async () => {
      // a 已先一步置 running——若不同 key 阻塞，这里要等 a 跑完才进来，aRunning 会是 false
      await tick();
      if (aRunning) bSawAConcurrent = true;
    });

    await Promise.all([a, b]);
    expect(bSawAConcurrent).toBe(true);
  });

  it('任务返回值正常透传给 caller', async () => {
    const r = await runExclusive('k', async () => 42);
    expect(r).toBe(42);
  });

  it('链上某任务抛错不拖垮同 key 后续任务，且错误透传给抛错那个 caller', async () => {
    const failing = runExclusive('k', async () => {
      throw new Error('boom');
    });
    await expect(failing).rejects.toThrow('boom');

    // 同 key 后续任务照常执行并拿到结果
    const next = await runExclusive('k', async () => 'ok');
    expect(next).toBe('ok');
  });
});
