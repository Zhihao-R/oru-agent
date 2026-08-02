/**
 * paths.ts 的 VITEST 硬护栏——回归：2026-07-10 backup 测试因 ORU_DIR 未与 vi.mock 同相位
 * 注入，paths.ts 提前求值捕获真实 ~/.oru，测试静默覆盖了真实用户数据。
 * 护栏语义：vitest 环境下 ORU_DIR 缺失时 paths.ts 必须拒绝加载（抛错），而非默认回落
 * homedir——隔离失效要响，绝不静默读写真实 ~/.oru。正常运行由 tests/setup/oruDir.ts 兜底注入。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('paths.ts VITEST 硬护栏', () => {
  const saved = process.env.ORU_DIR;
  afterEach(() => {
    vi.resetModules();
    if (saved === undefined) delete process.env.ORU_DIR;
    else process.env.ORU_DIR = saved;
  });

  it('ORU_DIR 缺失时加载即抛错，不回落 homedir', async () => {
    vi.resetModules();
    delete process.env.ORU_DIR;
    await expect(import('../../electron/main/runtime/paths')).rejects.toThrow(/ORU_DIR/);
  });

  it('ORU_DIR 已注入时正常加载且生效', async () => {
    vi.resetModules();
    process.env.ORU_DIR = '/tmp/oru-guard-probe';
    const mod = await import('../../electron/main/runtime/paths');
    expect(mod.ORU_DIR).toBe('/tmp/oru-guard-probe');
  });
});
