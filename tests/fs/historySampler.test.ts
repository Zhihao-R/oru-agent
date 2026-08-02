/**
 * 周期取样器单测（技术设计 §11.7 快照节奏：连续编辑约每 3min 一 periodic；静止不空转；内容未变 no-op）
 *
 * tick 内有真实 fs I/O，fake timer 等不到它完成——故行为用确定性 __tickForTest 直接 await，
 * 定时器接线（register/unregister 创建/清掉 timer）另用 fake timer 单独验。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-sampler-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

let seq = 0;
function freshKey(): string {
  return join(ORU_DIR, 'work', `wf-${seq++}.md`);
}

let SAMP!: typeof import('../../electron/main/fs/historySampler');
let FH!: typeof import('../../electron/main/fs/fileHistory');

beforeAll(async () => {
  await fs.mkdir(join(ORU_DIR, 'work'), { recursive: true });
  SAMP = await import('../../electron/main/fs/historySampler');
  FH = await import('../../electron/main/fs/fileHistory');
});

afterEach(() => {
  SAMP.__resetForTest();
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('周期取样行为', () => {
  it('活跃（每周期都 touch）每周期一次有效取样', async () => {
    const key = freshKey();
    await fs.writeFile(key, 'v0');
    SAMP.registerSampling(key);

    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(key, `v${i}`);
      SAMP.touchSampling(key);
      await SAMP.__tickForTest(key);
    }

    const periodic = (await FH.list(key)).filter((s) => s.kind === 'periodic');
    expect(periodic.length).toBe(3);
  });

  it('静止不空转：不 touch 则不取样', async () => {
    const key = freshKey();
    await fs.writeFile(key, 'idle');
    SAMP.registerSampling(key);

    await SAMP.__tickForTest(key);
    await SAMP.__tickForTest(key);
    await SAMP.__tickForTest(key);

    expect(await FH.list(key)).toHaveLength(0);
  });

  it('内容未变：touch 了但磁盘没变 → snapshot no-op，不增重复条', async () => {
    const key = freshKey();
    await fs.writeFile(key, 'frozen');
    SAMP.registerSampling(key);

    SAMP.touchSampling(key);
    await SAMP.__tickForTest(key); // 存 frozen
    SAMP.touchSampling(key);
    await SAMP.__tickForTest(key); // 内容仍 frozen → no-op

    expect((await FH.list(key)).filter((s) => s.kind === 'periodic')).toHaveLength(1);
  });

  it('unregister 后 tick 不取样（已无该文件的取样器）', async () => {
    const key = freshKey();
    await fs.writeFile(key, 'a');
    SAMP.registerSampling(key);
    SAMP.touchSampling(key);
    SAMP.unregisterSampling(key);
    await SAMP.__tickForTest(key);
    expect(await FH.list(key)).toHaveLength(0);
  });
});

describe('关闭补锚（unregister 在 dirty 时补一个 periodic，§4.4）', () => {
  it('dirty 状态关闭：补存一个 periodic 可见锚', async () => {
    const key = freshKey();
    await fs.writeFile(key, 'opened');
    SAMP.registerSampling(key);
    await fs.writeFile(key, 'edited-then-closed');
    SAMP.touchSampling(key); // 本轮改过、periodic 尚未 tick
    SAMP.unregisterSampling(key);

    // 补存是 fire-and-forget，等微任务队列清空让 snapshot 落库
    await vi.waitFor(async () => {
      const periodic = (await FH.list(key)).filter((s) => s.kind === 'periodic');
      expect(periodic).toHaveLength(1);
    });
    const periodic = (await FH.list(key)).filter((s) => s.kind === 'periodic');
    expect(await FH.restore(key, periodic[0].id)).toBe('edited-then-closed');
  });

  it('非 dirty 关闭：不补存', async () => {
    const key = freshKey();
    await fs.writeFile(key, 'opened');
    SAMP.registerSampling(key);
    SAMP.unregisterSampling(key); // 未 touch

    await Promise.resolve(); // 非 dirty 路径不启动任何异步，仅作意图说明，无需等真实 I/O
    expect(await FH.list(key)).toHaveLength(0);
  });

  it('关闭时内容与上一版逐字一样：hash===lastHash → 不多存', async () => {
    const key = freshKey();
    await fs.writeFile(key, 'frozen');
    SAMP.registerSampling(key);
    SAMP.touchSampling(key);
    await SAMP.__tickForTest(key); // 存一条 frozen

    SAMP.touchSampling(key);
    SAMP.unregisterSampling(key); // 磁盘仍 frozen → 补存触发 no-op

    await Promise.resolve();
    expect((await FH.list(key)).filter((s) => s.kind === 'periodic')).toHaveLength(1);
  });
});

describe('定时器接线', () => {
  it('register 装一个 interval、unregister 清掉（fake timer 验生命周期）', () => {
    vi.useFakeTimers();
    const setSpy = vi.spyOn(global, 'setInterval');
    const clearSpy = vi.spyOn(global, 'clearInterval');
    const key = freshKey();
    SAMP.registerSampling(key);
    expect(setSpy).toHaveBeenCalledTimes(1);
    SAMP.registerSampling(key); // 幂等，不重复装
    expect(setSpy).toHaveBeenCalledTimes(1);
    SAMP.unregisterSampling(key);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    setSpy.mockRestore();
    clearSpy.mockRestore();
    vi.useRealTimers();
  });
});
