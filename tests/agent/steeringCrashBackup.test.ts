/**
 * Steering 崩溃落盘兜底回归（2026-07-03 审计 critical#1）。
 *
 * 承重方向（PM 拍板）：
 *  1. 入队即留 pending 盘记；消费前崩溃 → 重启扫描交还（预填草稿），绝不静默蒸发。
 *  2. 消费 = persist 成功那一刻同步清盘记；崩在「persist 成功但清除前」→ 重启重复交还——
 *     钉死「宁可交还重复、不可静默丢」的方向。
 *  3. Esc（drainUnconsumedOnAbort）交还过的项，盘记同步清——崩溃重启后不再交还第二遍。
 *  4. 并发：消费与新 enqueue 交错（同锁串行）时盘记不串；跨 conv 隔离。
 *
 * ORU_DIR 范式：顶层先设 env，被测模块全动态 import；「模拟进程重启」= vi.resetModules()
 * 后重新 import（全新内存队列/注册表，读同一 ORU_DIR 磁盘）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-steering-crash-backup-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

/** 模拟进程（重）启动：全新模块实例（内存清零），磁盘不动。 */
async function bootModules() {
  vi.resetModules();
  const q = await import('../../electron/main/agent/steeringQueue');
  const b = await import('../../electron/main/agent/steeringBackup');
  return { ...q, ...b };
}

function pendingFilePath(agentId: string, convId: string): string {
  return join(ORU_DIR, 'users', 'local-user', 'conversations', agentId, `${convId}.steering-pending.json`);
}

function recoveredFilePath(agentId: string, convId: string): string {
  return join(ORU_DIR, 'users', 'local-user', 'conversations', agentId, `${convId}.steering-recovered.json`);
}

async function readPendingTexts(agentId: string, convId: string): Promise<string[]> {
  const p = pendingFilePath(agentId, convId);
  if (!existsSync(p)) return [];
  const parsed = JSON.parse(await fs.readFile(p, 'utf-8')) as { pending: Array<{ text: string }> };
  return parsed.pending.map((m) => m.text);
}

describe('崩溃兜底：入队未消费 → 重启扫描交还 → 交还后清除（目标问题本身）', () => {
  it('enqueue 后不消费，模拟重启：扫描到盘记、peek 拿到原文本、ack 后再扫为空', async () => {
    const m1 = await bootModules();
    const key = m1.steeringKey('agtA', 'cnvCrash');
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'starter', text: '起回合' , trigger: 'user' }); // started 不入队
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'a', text: '排队中甲' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'b', text: '排队中乙' , trigger: 'user' });

    // 崩溃重启：新进程扫描到残留盘记，交还路径拿到原文本（顺序保持入队序）
    const m2 = await bootModules();
    await m2.scanSteeringBackupsOnBoot();
    expect(m2.peekRecoveredSteering('cnvCrash')?.map((m) => m.text)).toEqual(['排队中甲', '排队中乙']);

    // 交还送达确认后盘记清除；再重启再扫为空——同一批不会交还两次
    await m2.ackRecoveredSteering('cnvCrash');
    expect(m2.peekRecoveredSteering('cnvCrash')).toBeNull();
    const m3 = await bootModules();
    await m3.scanSteeringBackupsOnBoot();
    expect(m3.peekRecoveredSteering('cnvCrash')).toBeNull();
  });

  it('定时任务忙时入队的项（kind=scheduled-trigger）同样有盘记兜底，原始文本交还', async () => {
    const m1 = await bootModules();
    const key = m1.steeringKey('agtA', 'cnvSched');
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'starter', text: '起回合' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(key, {
      clientMsgId: 'trig',
      text: '<scheduled-task-trigger>…</scheduled-task-trigger>',
      trigger: 'scheduled',
      kind: 'scheduled-trigger',
      scheduledTrigger: { taskId: 'tsk1', title: '晨报' },
    });

    const m2 = await bootModules();
    await m2.scanSteeringBackupsOnBoot();
    expect(m2.peekRecoveredSteering('cnvSched')?.map((m) => m.text)).toEqual(['<scheduled-task-trigger>…</scheduled-task-trigger>']);
  });
});

describe('消费清除：persist 成功那一刻同步清盘记', () => {
  it('enqueue → 正常消费（pullSteering persist 成功）→ 盘记清除，重启不再交还', async () => {
    const m1 = await bootModules();
    const key = m1.steeringKey('agtA', 'cnvConsume');
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'starter', text: '起回合' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'a', text: '会被消费' , trigger: 'user' });
    expect(await readPendingTexts('agtA', 'cnvConsume')).toEqual(['会被消费']); // 入队即有盘记

    await m1.steeringQueue.pullSteering(key, m1.steeringQueue.runToken(key), async () => {}); // 消费=persist 那一刻
    expect(existsSync(pendingFilePath('agtA', 'cnvConsume'))).toBe(false);

    const m2 = await bootModules();
    await m2.scanSteeringBackupsOnBoot();
    expect(m2.peekRecoveredSteering('cnvConsume')).toBeNull();
  });

  it('persist 失败 → 整批留队列、盘记也保留（不因失败丢兜底）', async () => {
    const m1 = await bootModules();
    const key = m1.steeringKey('agtA', 'cnvPersistFail');
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'starter', text: '起回合' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'a', text: '落盘失败留队列' , trigger: 'user' });
    await expect(
      m1.steeringQueue.pullSteering(key, m1.steeringQueue.runToken(key), async () => {
        throw new Error('落盘失败');
      }),
    ).rejects.toThrow('落盘失败');
    expect(await readPendingTexts('agtA', 'cnvPersistFail')).toEqual(['落盘失败留队列']);
  });

  it('【方向钉死】崩在「persist 成功但盘记清除前」：消费不失败，重启后重复交还（宁重复不丢）', async () => {
    const m1 = await bootModules();
    // 包一层 backup：清除（空数组）时抛错 = 模拟「persist 成功后、清盘记前」进程状态坏掉
    const clearFailingBackup = {
      save: (key: string, pending: unknown[]) =>
        pending.length === 0
          ? Promise.reject(new Error('清除时崩溃'))
          : m1.fileSteeringBackup.save(key, pending as never),
    } satisfies import('../../electron/main/agent/steeringQueue').SteeringBackup;
    let n = 0;
    const q = m1.createSteeringQueue(() => `s${(n += 1)}`, clearFailingBackup);
    const key = m1.steeringKey('agtA', 'cnvDupDir');
    await q.enqueueOrStart(key, { clientMsgId: 'starter', text: '起回合' , trigger: 'user' });
    await q.enqueueOrStart(key, { clientMsgId: 'a', text: '已消费但盘记残留' , trigger: 'user' });

    const persisted: string[] = [];
    // 清盘记失败不允许把已成功的消费变成失败（不 reject、不把批留队列重复投递）
    await expect(
      q.pullSteering(key, q.runToken(key), async (msgs) => {
        persisted.push(...msgs.map((m) => m.text));
      }),
    ).resolves.toBeDefined();
    expect(persisted).toEqual(['已消费但盘记残留']);
    expect(q.pendingCount(key)).toBe(0);

    // 重启：盘记还在 → 重复交还（方向：宁可重复、不可静默丢）
    const m2 = await bootModules();
    await m2.scanSteeringBackupsOnBoot();
    expect(m2.peekRecoveredSteering('cnvDupDir')?.map((m) => m.text)).toEqual(['已消费但盘记残留']);
  });
});

describe('Esc 交还清除：drainUnconsumedOnAbort 后盘记同步清', () => {
  it('Esc 退回输入框的项，重启后不再交还第二遍', async () => {
    const m1 = await bootModules();
    const key = m1.steeringKey('agtA', 'cnvEsc');
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'starter', text: '起回合' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'a', text: 'Esc 退回' , trigger: 'user' });
    expect(await readPendingTexts('agtA', 'cnvEsc')).toEqual(['Esc 退回']);

    const drained = await m1.steeringQueue.drainUnconsumedOnAbort(key);
    expect(drained.map((m) => m.text)).toEqual(['Esc 退回']);
    expect(existsSync(pendingFilePath('agtA', 'cnvEsc'))).toBe(false);

    const m2 = await bootModules();
    await m2.scanSteeringBackupsOnBoot();
    expect(m2.peekRecoveredSteering('cnvEsc')).toBeNull();
  });

  it('撤回（withdraw）后盘记同步收窄到剩余项', async () => {
    const m1 = await bootModules();
    const key = m1.steeringKey('agtA', 'cnvWithdraw');
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'starter', text: '起回合' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'a', text: '被撤回' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'b', text: '留下' , trigger: 'user' });
    expect(await m1.steeringQueue.withdraw(key, 'a')).toBe('removed');
    expect(await readPendingTexts('agtA', 'cnvWithdraw')).toEqual(['留下']);
  });
});

describe('入队盘记失败：回滚 + 上抛（「不给假 ACK」的承诺）', () => {
  it('backup.save 抛错 → enqueue reject、队列回滚为空，后续回合收尾不会捞出幽灵项', async () => {
    const m1 = await bootModules();
    const failingBackup = {
      save: (_key: string, pending: unknown[]) =>
        pending.length > 0 ? Promise.reject(new Error('盘记写失败')) : Promise.resolve(),
    } satisfies import('../../electron/main/agent/steeringQueue').SteeringBackup;
    let n = 0;
    const q = m1.createSteeringQueue(() => `s${(n += 1)}`, failingBackup);
    const key = m1.steeringKey('agtA', 'cnvHonestAck');
    await q.enqueueOrStart(key, { clientMsgId: 'starter', text: '起回合' , trigger: 'user' }); // started 不写盘记
    await expect(q.enqueueOrStart(key, { clientMsgId: 'a', text: '写不进盘' , trigger: 'user' })).rejects.toThrow('盘记写失败');
    expect(q.pendingCount(key)).toBe(0); // 已回滚——不存在「ACK 了却没兜底」的中间态
    await expect(q.concludeTurn(key, q.runToken(key), async () => {})).resolves.toEqual({ idle: true });
  });
});

describe('过户面：recovered 与 pending 并存 / 单 conv 失败不拖累', () => {
  it('recovered（上上次未交还完）与 pending（上次活队列）并存：合并过户，更早的 recovered 在前', async () => {
    // 第一代进程：入队「早批」，未消费即崩
    const m1 = await bootModules();
    const k1 = m1.steeringKey('agtA', 'cnvMerge');
    await m1.steeringQueue.enqueueOrStart(k1, { clientMsgId: 's', text: '起' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(k1, { clientMsgId: 'a', text: '早批' , trigger: 'user' });

    // 第二代进程：扫描已过户成 recovered，但用户没打开对话（未 ack）；期间又有新入队，随后再崩
    const m2 = await bootModules();
    await m2.scanSteeringBackupsOnBoot();
    const k2 = m2.steeringKey('agtA', 'cnvMerge');
    await m2.steeringQueue.enqueueOrStart(k2, { clientMsgId: 's', text: '起' , trigger: 'user' });
    await m2.steeringQueue.enqueueOrStart(k2, { clientMsgId: 'b', text: '晚批' , trigger: 'user' });

    // 第三代进程：两文件并存 → 合并成一份 recovered（时间序），pending 删除
    const m3 = await bootModules();
    await m3.scanSteeringBackupsOnBoot();
    expect(m3.peekRecoveredSteering('cnvMerge')?.map((m) => m.text)).toEqual(['早批', '晚批']);
    expect(existsSync(pendingFilePath('agtA', 'cnvMerge'))).toBe(false);
    expect(existsSync(recoveredFilePath('agtA', 'cnvMerge'))).toBe(true);
  });

  it('【必修回归】某 conv 过户写盘失败：其他 conv 照常过户交还，失败 conv 本会话也不静默丢（修复前红）', async () => {
    const m1 = await bootModules();
    const kBad = m1.steeringKey('agtA', 'cnvMigrateBad');
    const kGood = m1.steeringKey('agtB', 'cnvMigrateGood');
    await m1.steeringQueue.enqueueOrStart(kBad, { clientMsgId: 's1', text: '起1' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(kBad, { clientMsgId: 'a', text: '坏盘残留' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(kGood, { clientMsgId: 's2', text: '起2' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(kGood, { clientMsgId: 'b', text: '好盘残留' , trigger: 'user' });

    // 模拟重启 + 坏 conv 的 recovered 文件写盘持续失败（其余路径走真实盘）
    vi.resetModules();
    vi.doMock('../../electron/main/fs/safeWrite', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../../electron/main/fs/safeWrite')>();
      return {
        ...actual,
        safeWriteAsync: async (absPath: string, content: string, lineEnding?: 'LF' | 'CRLF') => {
          if (absPath.includes('cnvMigrateBad')) throw new Error('模拟写盘失败');
          return actual.safeWriteAsync(absPath, content, lineEnding);
        },
      } satisfies typeof import('../../electron/main/fs/safeWrite');
    });
    try {
      const b = await import('../../electron/main/agent/steeringBackup');
      await expect(b.scanSteeringBackupsOnBoot()).resolves.toBeUndefined(); // 单 conv 失败不上抛
      expect(b.peekRecoveredSteering('cnvMigrateGood')?.map((m) => m.text)).toEqual(['好盘残留']); // 不被坏 conv 拖累
      expect(b.peekRecoveredSteering('cnvMigrateBad')?.map((m) => m.text)).toEqual(['坏盘残留']); // 残留已在内存，仍走本会话交还
    } finally {
      vi.doUnmock('../../electron/main/fs/safeWrite');
    }
  });
});

describe('对话删除：steering 盘记随对话销毁（不留孤儿文件/幽灵交还）', () => {
  it('deleteConversation 连带删 pending/recovered 盘记并清待交还区', async () => {
    // 第一代进程：建对话 + 入队未消费即崩
    const m1 = await bootModules();
    const store1 = await import('../../electron/main/conversations/store');
    const conv = await store1.createConversation({ agentId: 'agtDel', title: '将删', kind: 'sub' });
    const key = m1.steeringKey('agtDel', conv.id);
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 's', text: '起' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'a', text: '将成孤儿' , trigger: 'user' });

    // 第二代进程：扫描过户进待交还区后，用户删除该对话
    const m2 = await bootModules();
    await m2.scanSteeringBackupsOnBoot();
    expect(m2.peekRecoveredSteering(conv.id)?.map((m) => m.text)).toEqual(['将成孤儿']);
    // 再造一份 pending 并存（删除前又有忙时入队）
    await m2.steeringQueue.enqueueOrStart(m2.steeringKey('agtDel', conv.id), { clientMsgId: 's', text: '起' , trigger: 'user' });
    await m2.steeringQueue.enqueueOrStart(m2.steeringKey('agtDel', conv.id), { clientMsgId: 'b', text: '也成孤儿' , trigger: 'user' });

    const store2 = await import('../../electron/main/conversations/store');
    await store2.deleteConversation('agtDel', conv.id);
    expect(existsSync(pendingFilePath('agtDel', conv.id))).toBe(false);
    expect(existsSync(recoveredFilePath('agtDel', conv.id))).toBe(false);
    expect(m2.peekRecoveredSteering(conv.id)).toBeNull(); // 待交还区同步清，不幽灵交还
  });
});

describe('并发面：消费与新 enqueue 交错时盘记不串（RMW 同锁）', () => {
  it('同 conv：pull 与 enqueue 并发——锁串行后盘记 ≡ 内存队列（只剩迟到那条）', async () => {
    const m1 = await bootModules();
    const key = m1.steeringKey('agtA', 'cnvRace');
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'starter', text: '起回合' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'a', text: '先入队' , trigger: 'user' });
    await Promise.all([
      m1.steeringQueue.pullSteering(key, m1.steeringQueue.runToken(key), async () => {}),
      m1.steeringQueue.enqueueOrStart(key, { clientMsgId: 'late', text: '迟到' , trigger: 'user' }),
    ]);
    expect(m1.steeringQueue.pendingCount(key)).toBe(1);
    expect(await readPendingTexts('agtA', 'cnvRace')).toEqual(['迟到']);
  });

  it('跨 conv 隔离：conv1 消费不动 conv2 的盘记', async () => {
    const m1 = await bootModules();
    const k1 = m1.steeringKey('agtA', 'cnvIso1');
    const k2 = m1.steeringKey('agtB', 'cnvIso2');
    await m1.steeringQueue.enqueueOrStart(k1, { clientMsgId: 's1', text: '起1' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(k1, { clientMsgId: 'a', text: '一号队列' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(k2, { clientMsgId: 's2', text: '起2' , trigger: 'user' });
    await m1.steeringQueue.enqueueOrStart(k2, { clientMsgId: 'b', text: '二号队列' , trigger: 'user' });
    await m1.steeringQueue.pullSteering(k1, m1.steeringQueue.runToken(k1), async () => {});
    expect(existsSync(pendingFilePath('agtA', 'cnvIso1'))).toBe(false);
    expect(await readPendingTexts('agtB', 'cnvIso2')).toEqual(['二号队列']);
  });
});
