/**
 * 用量账本单测（S13 · G110）——聚合、时间范围、持久化往返、损坏清零。
 * 必须先 process.env.ORU_DIR 重定向再动态 import（runtime/paths 在 load 时锁死路径）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-usage-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'local-user';
const ledgerFile = join(ORU_DIR, 'users', OWNER, 'usage-ledger.json');

type Mod = typeof import('../../electron/main/usage/ledger');
let L!: Mod;

// 固定时刻，避开 Date.now 漂移：2026-07-11 与 07-10 的本地正午
const DAY_11 = new Date(2026, 6, 11, 12, 0, 0).getTime();
const DAY_10 = new Date(2026, 6, 10, 12, 0, 0).getTime();

beforeAll(async () => {
  await fs.mkdir(join(ORU_DIR, 'users', OWNER), { recursive: true });
  L = await import('../../electron/main/usage/ledger');
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(async () => {
  L.__resetUsageLedgerForTest();
  await fs.rm(ledgerFile, { force: true });
});

describe('recordUsage + summarize', () => {
  it('按 (日期,用途) 累计，一次调用计一次 calls', async () => {
    await L.recordUsage('twinMain', { inputTokens: 100, outputTokens: 20 }, DAY_11);
    await L.recordUsage('twinMain', { inputTokens: 50, outputTokens: 10 }, DAY_11);
    await L.recordUsage('memoryRecall', { inputTokens: 8, outputTokens: 2 }, DAY_11);

    const days = await L.getUsageDays(OWNER);
    const { summarizeUsage } = await import('../../shared/usage/summarize');
    const sum = summarizeUsage(days, {});
    expect(sum.total).toEqual({ inputTokens: 158, outputTokens: 32, calls: 3 });
    // 按 token 总量降序
    expect(sum.byPurpose.map((r) => r.purpose)).toEqual(['twinMain', 'memoryRecall']);
    const main = sum.byPurpose.find((r) => r.purpose === 'twinMain');
    expect(main).toMatchObject({ inputTokens: 150, outputTokens: 30, calls: 2 });
  });

  it('时间范围过滤：只算 from 当天及以后', async () => {
    await L.recordUsage('twinMain', { inputTokens: 100, outputTokens: 0 }, DAY_10);
    await L.recordUsage('twinMain', { inputTokens: 5, outputTokens: 0 }, DAY_11);
    const days = await L.getUsageDays(OWNER);
    const { summarizeUsage } = await import('../../shared/usage/summarize');
    const onlyToday = summarizeUsage(days, { from: DAY_11 });
    expect(onlyToday.total.inputTokens).toBe(5);
    const all = summarizeUsage(days, {});
    expect(all.total.inputTokens).toBe(105);
  });

  it('usage 缺省 token 仍计 calls，但零 token 用途不列入 byPurpose', async () => {
    await L.recordUsage('conversationTitle', {}, DAY_11); // 拿到 usage 但 0 token
    const days = await L.getUsageDays(OWNER);
    const { summarizeUsage } = await import('../../shared/usage/summarize');
    const sum = summarizeUsage(days, {});
    expect(sum.total.calls).toBe(1);
    expect(sum.byPurpose).toEqual([]); // 零 token 不占行
  });
});

describe('持久化往返', () => {
  it('flush 落盘后清缓存重载，账目一致', async () => {
    await L.recordUsage('twinMain', { inputTokens: 42, outputTokens: 7 }, DAY_11);
    await L.flushUsageLedger();
    const onDisk = JSON.parse(await fs.readFile(ledgerFile, 'utf-8'));
    expect(onDisk.version).toBe(1);

    L.__resetUsageLedgerForTest();
    const days = await L.getUsageDays(OWNER);
    const { summarizeUsage } = await import('../../shared/usage/summarize');
    expect(summarizeUsage(days, {}).total).toEqual({ inputTokens: 42, outputTokens: 7, calls: 1 });
  });

  it('已有账本上继续累计（load 合流不清零既有）', async () => {
    await L.recordUsage('twinMain', { inputTokens: 10, outputTokens: 0 }, DAY_11);
    await L.flushUsageLedger();
    L.__resetUsageLedgerForTest();
    // 重载后再记一笔——应叠加到磁盘既有值上
    await L.recordUsage('twinMain', { inputTokens: 5, outputTokens: 0 }, DAY_11);
    await L.flushUsageLedger();
    const onDisk = JSON.parse(await fs.readFile(ledgerFile, 'utf-8'));
    expect(onDisk.days['2026-07-11'].twinMain.inputTokens).toBe(15);
  });

  it('损坏账本清零重建，不 throw', async () => {
    await fs.writeFile(ledgerFile, '{ 坏 json', 'utf-8');
    L.__resetUsageLedgerForTest();
    await expect(L.recordUsage('twinMain', { inputTokens: 3, outputTokens: 0 }, DAY_11)).resolves.toBeUndefined();
    const days = await L.getUsageDays(OWNER);
    const { summarizeUsage } = await import('../../shared/usage/summarize');
    expect(summarizeUsage(days, {}).total.inputTokens).toBe(3);
  });
});
