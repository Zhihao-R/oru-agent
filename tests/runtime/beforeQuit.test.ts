/**
 * before-quit 一次性语义回归——目标问题：三个 stop（idleAnnouncer / dream / wsServer）
 * 原先放在 quitting 守卫之前，app.quit() 重新触发 before-quit 时会重复执行
 * （stop 已停的调度器、关已关的 server）。修复后 stop 在守卫之内：
 * 跨任意次触发恰好执行一次，preventDefault / flush / quit 也各一次。
 */
import { describe, expect, it, vi } from 'vitest';
import { createBeforeQuitHandler } from '../../electron/main/runtime/beforeQuit';

function makeDeps() {
  let resolveFlush!: () => void;
  const flushGate = new Promise<void>((r) => (resolveFlush = r));
  const stops = [vi.fn(), vi.fn(), vi.fn()];
  const flush = vi.fn(() => flushGate);
  const quit = vi.fn();
  return { stops, flush, quit, resolveFlush };
}

describe('createBeforeQuitHandler', () => {
  it('首次触发：stop 全跑 + preventDefault + flush 完才 quit', async () => {
    const { stops, flush, quit, resolveFlush } = makeDeps();
    const handler = createBeforeQuitHandler({ stops, flush, quit });
    const e = { preventDefault: vi.fn() };

    handler(e);
    for (const s of stops) expect(s).toHaveBeenCalledTimes(1);
    expect(e.preventDefault).toHaveBeenCalledTimes(1);
    expect(quit).not.toHaveBeenCalled(); // flush 未完，不许 quit

    resolveFlush();
    await new Promise((r) => setTimeout(r, 0));
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('quit() 重新触发 before-quit：stop 不重复执行、不再 preventDefault（目标回归）', async () => {
    const { stops, flush, quit, resolveFlush } = makeDeps();
    const handler = createBeforeQuitHandler({ stops, flush, quit });
    const e1 = { preventDefault: vi.fn() };
    const e2 = { preventDefault: vi.fn() };

    handler(e1);
    resolveFlush();
    await new Promise((r) => setTimeout(r, 0));
    handler(e2); // 模拟 deps.quit() → app.quit() 再次触发

    for (const s of stops) expect(s).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(e2.preventDefault).not.toHaveBeenCalled(); // 放行，让退出真正发生
  });

  it('flush reject 也必须 quit（finally 兜底），否则首次退出静默失效', async () => {
    const stops = [vi.fn()];
    const quit = vi.fn();
    const handler = createBeforeQuitHandler({
      stops,
      flush: vi.fn(() => Promise.reject(new Error('落盘炸了'))),
      quit,
    });
    handler({ preventDefault: vi.fn() });
    await new Promise((r) => setTimeout(r, 0));
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it('flush 进行中重复触发（用户连按 Cmd+Q）：同样只跑一遍', () => {
    const { stops, flush, quit } = makeDeps();
    const handler = createBeforeQuitHandler({ stops, flush, quit });
    handler({ preventDefault: vi.fn() });
    handler({ preventDefault: vi.fn() });
    handler({ preventDefault: vi.fn() });
    for (const s of stops) expect(s).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledTimes(1);
  });
});
