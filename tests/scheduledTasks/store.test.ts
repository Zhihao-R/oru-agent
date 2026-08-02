/**
 * scheduledTasks/store 持久化回归
 *
 * 目标问题（对齐 tasks/store 的「RMW 整块必须入锁」铁律）：两个并发 patch 改不同字段，
 * 必须都保留——若读在锁外、只锁 write，后写覆盖先写会丢更新。
 * 另验 hydrate 给老数据补默认（createdBy/runCount/enabled 等新字段对历史数据安全）。
 *
 * 走 process.env.ORU_DIR 重定向 tmpdir + 动态 import（避免 paths.ts 在 load 时锁死 ORU_DIR）。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ScheduledTask } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-sched-store-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'test-owner';
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => OWNER,
  LOCAL_USER_ID: OWNER,
}));

function baseTask(id: string, over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    groupId: id,
    ownerId: OWNER,
    agentId: 'twin',
    title: '每日简报',
    prompt: '汇总昨天的笔记',
    runLocation: { kind: 'newConversation' },
    spec: { kind: 'daily', minutesOfDay: 8 * 60 },
    enabled: true,
    createdBy: 'user',
    nextRunAt: 0,
    runCount: 0,
    tz: 'UTC',
    pendingFires: [],
    runHistory: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

describe('scheduledTasks/store', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('create → get round-trip 完整保真', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    const t = baseTask('rt1', { spec: { kind: 'interval', every: 3, unit: 'hour' }, stopAfterRuns: 3 });
    await store.createScheduledTask(t);
    expect(await store.getScheduledTask('rt1')).toEqual(t);
  });

  it('并发 patch 改不同字段：两者都保留（锁内 RMW）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('race1'));
    await Promise.all([
      store.patchScheduledTask('race1', { enabled: false }),
      store.patchScheduledTask('race1', { runCount: 5 }),
    ]);
    const got = await store.getScheduledTask('race1');
    expect(got?.enabled).toBe(false);
    expect(got?.runCount).toBe(5);
  });

  it('并发 recordRun：runCount 自增不丢（锁内自增）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('rec1'));
    await Promise.all([
      store.recordRun('rec1', { at: 1, ok: true, late: false }),
      store.recordRun('rec1', { at: 2, ok: false, late: false, error: 'boom' }),
    ]);
    const got = await store.getScheduledTask('rec1');
    expect(got?.runCount).toBe(2);
    expect(got?.lastRun).toBeDefined();
  });

  it('patch 不存在的 id → null', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    expect(await store.patchScheduledTask('nope', { enabled: false })).toBeNull();
  });

  it('hydrate 给缺字段的老数据补默认', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    const t = store.__hydrateForTest({
      id: 'old1',
      spec: { kind: 'daily', minutesOfDay: 480 },
      prompt: 'x',
    });
    expect(t.createdBy).toBe('user');
    expect(t.runCount).toBe(0);
    expect(t.enabled).toBe(true);
    expect(t.runLocation).toEqual({ kind: 'newConversation' });
    expect(t.ownerId).toBe(OWNER);
  });

  it('hydrate 给缺 groupId 的老数据补 groupId=自己 id（自成一组）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    const t = store.__hydrateForTest({
      id: 't1',
      spec: { kind: 'daily', minutesOfDay: 480 },
      prompt: 'x',
    });
    expect(t.groupId).toBe('t1');
  });

  it('list 返回全部、delete 后移除', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('l1'));
    await store.createScheduledTask(baseTask('l2'));
    const ids = (await store.listScheduledTasks()).map((t) => t.id);
    expect(ids).toEqual(expect.arrayContaining(['l1', 'l2']));
    await store.deleteScheduledTask('l1');
    const after = (await store.listScheduledTasks()).map((t) => t.id);
    expect(after).not.toContain('l1');
    expect(after).toContain('l2');
  });
});

// ─── S18 · G41/G43：投递账原语（recordFire / settleRun / discardFires）───────────
describe('scheduledTasks/store — 投递账原语（S18）', () => {
  it('recordFire：推进游标 + 追加一笔账，同一次落盘', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('fire1', { nextRunAt: 100 }));
    const after = await store.recordFire('fire1', { dueAt: 100, firedAt: 105 }, () => ({ nextRunAt: 200, enabled: true }));
    expect(after?.nextRunAt).toBe(200);
    expect(after?.pendingFires).toEqual([{ dueAt: 100, firedAt: 105 }]);
    // 落盘一致
    const got = await store.getScheduledTask('fire1');
    expect(got?.pendingFires).toEqual([{ dueAt: 100, firedAt: 105 }]);
  });

  it('recordFire：computeAdvance 在锁内基于最新 cur 算（用户中途暂停不被覆盖回 enabled:true）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('fire2', { nextRunAt: 100, enabled: false })); // 已被用户暂停
    // 模拟 fireDueTask 的算子：periodic 任务 advanceNextRun 保留 cur.enabled——暂停态应被尊重
    const after = await store.recordFire('fire2', { dueAt: 100, firedAt: 105 }, (cur) => ({
      nextRunAt: 200,
      enabled: cur.enabled, // 基于锁内最新 cur，而非锁外快照
    }));
    expect(after?.enabled).toBe(false); // 暂停未被复活
  });

  it('settleRun：落 lastRun + 销全部账 + 到点账≥1 计次一次（合并多拍计一）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(
      baseTask('settle1', { runCount: 2, pendingFires: [{ dueAt: 1, firedAt: 1 }, { dueAt: 2, firedAt: 2 }] }),
    );
    const after = await store.settleRun('settle1', { at: 9, status: 'ok', late: false });
    expect(after?.runCount).toBe(3); // 2 拍合并计一
    expect(after?.pendingFires).toEqual([]);
    expect(after?.lastRun).toEqual({ at: 9, status: 'ok', late: false });
  });

  it('settleRun：追加运行记录（G45 可回溯，新→旧、带承载对话）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('hist1', { pendingFires: [{ dueAt: 1, firedAt: 1 }] }));
    await store.settleRun('hist1', { at: 10, status: 'ok', late: false }, { conversationId: 'conv-a' });
    const after = await store.settleRun('hist1', { at: 20, status: 'error', late: false }, { conversationId: 'conv-b' });
    expect(after?.runHistory).toEqual([
      { at: 20, status: 'error', late: false, conversationId: 'conv-b' },
      { at: 10, status: 'ok', late: false, conversationId: 'conv-a' },
    ]);
  });

  it('settleRun：运行记录截到上限 30 条（远端截断）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    const seed = Array.from({ length: 30 }, (_, i) => ({ at: i, status: 'ok' as const, late: false }));
    await store.createScheduledTask(baseTask('histCap', { runHistory: seed, pendingFires: [{ dueAt: 1, firedAt: 1 }] }));
    const after = await store.settleRun('histCap', { at: 999, status: 'ok', late: false });
    expect(after?.runHistory).toHaveLength(30);
    expect(after?.runHistory?.[0]).toMatchObject({ at: 999 });
    expect(after?.runHistory?.at(-1)).toMatchObject({ at: 28 }); // 最老的 at:0 被挤出
  });

  it('settleRun：纯手动批（无账）不计次', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('settle2', { runCount: 5, pendingFires: [] }));
    const after = await store.settleRun('settle2', { at: 9, status: 'ok', late: false });
    expect(after?.runCount).toBe(5);
  });

  it('settleRun clearMissed：late 成功后连带清 missedAt', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('settle3', { missedAt: 50, pendingFires: [{ dueAt: 1, firedAt: 1 }] }));
    const after = await store.settleRun('settle3', { at: 9, status: 'ok', late: true }, { clearMissed: true });
    expect(after?.missedAt).toBeUndefined();
  });

  it('settleRun：once 任务跑过即终态停用（停用收敛到结算单点·S18 critical 修复）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(
      baseTask('settleOnce', { spec: { kind: 'once', at: 1000 }, enabled: true, nextRunAt: null, pendingFires: [{ dueAt: 1000, firedAt: 1001 }] }),
    );
    const after = await store.settleRun('settleOnce', { at: 9, status: 'ok', late: false });
    expect(after?.runCount).toBe(1);
    expect(after?.enabled).toBe(false); // 结算落定停用（fire 已 deferDisable 保留 enabled）
  });

  it('settleRun：stopAfterRuns 到顶经结算停用；未到顶保持启用', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(
      baseTask('settleLast', { stopAfterRuns: 3, runCount: 2, enabled: true, pendingFires: [{ dueAt: 1, firedAt: 1 }] }),
    );
    const last = await store.settleRun('settleLast', { at: 9, status: 'ok', late: false });
    expect(last?.runCount).toBe(3);
    expect(last?.enabled).toBe(false); // 到顶停用

    await store.createScheduledTask(
      baseTask('settleMid', { stopAfterRuns: 3, runCount: 0, enabled: true, pendingFires: [{ dueAt: 1, firedAt: 1 }] }),
    );
    const mid = await store.settleRun('settleMid', { at: 9, status: 'ok', late: false });
    expect(mid?.enabled).toBe(true); // 未到顶仍启用
  });

  it('settleRun：普通周期任务结算后仍启用（终态停用只对 once/末次）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('settleDaily', { enabled: true, pendingFires: [{ dueAt: 1, firedAt: 1 }] }));
    const after = await store.settleRun('settleDaily', { at: 9, status: 'ok', late: false });
    expect(after?.enabled).toBe(true);
  });

  it('discardFires：清账、不计次、不落 lastRun', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(
      baseTask('disc1', { runCount: 3, pendingFires: [{ dueAt: 1, firedAt: 1 }] }),
    );
    await store.discardFires('disc1');
    const got = await store.getScheduledTask('disc1');
    expect(got?.pendingFires).toEqual([]);
    expect(got?.runCount).toBe(3);
    expect(got?.lastRun).toBeUndefined();
  });

  it('attacker：并发 recordFire × settleRun 无账目复活（已销的拍不得回账）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    // 起始已有一拍账；并发地 settle（销账+计次）与 recordFire（追加新拍）。
    // 锁内 RMW 保证：无论谁先落，结果里绝不出现「已销的旧拍复活」——最终账要么是空（settle 后 fire 先跑再被 settle 覆盖不可能，因串行），
    // 要么恰是新追加的那拍；runCount 至多 +1（旧拍那次结算）。
    await store.createScheduledTask(baseTask('atk1', { runCount: 0, pendingFires: [{ dueAt: 1, firedAt: 1 }] }));
    await Promise.all([
      store.settleRun('atk1', { at: 9, status: 'ok', late: false }),
      store.recordFire('atk1', { dueAt: 2, firedAt: 2 }, () => ({ nextRunAt: 300, enabled: true })),
    ]);
    const got = await store.getScheduledTask('atk1');
    // 旧拍 {dueAt:1} 绝不复活：账里最多只有新拍 {dueAt:2}（若 recordFire 后跑）或空（若 settle 后跑）
    expect(got?.pendingFires?.some((f) => f.dueAt === 1)).toBe(false);
    expect(got?.runCount).toBe(1); // 旧拍结算恰好计一次
  });
});

// ─── S06 · G128/G129：格式版本号 + 迁移前原样副本 ───────────────────────────
describe('scheduledTasks/store — 格式版本号（S06）', () => {
  const dir = join(ORU_DIR, 'users', OWNER, 'scheduled-tasks');
  beforeAll(async () => {
    await fs.mkdir(dir, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('新建落盘带版本 envelope（{version, task}）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await store.createScheduledTask(baseTask('v_new'));
    const raw = JSON.parse(await fs.readFile(join(dir, 'v_new.json'), 'utf-8'));
    expect(typeof raw.version).toBe('number');
    expect(raw.task.id).toBe('v_new');
  });

  it('老裸格式（无 version）读得出，且首次读时落迁移前原样副本（G129）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    const bare = JSON.stringify(baseTask('v_old', { title: '老格式任务' }));
    await fs.writeFile(join(dir, 'v_old.json'), bare);
    const t = await store.getScheduledTask('v_old');
    expect(t?.title).toBe('老格式任务');
    // 迁移前原样副本：字节级一致
    expect(await fs.readFile(join(dir, 'v_old.json.pre-v1.bak'), 'utf-8')).toBe(bare);
    // 副本文件不会被 list 当任务读进来
    const ids = (await store.listScheduledTasks()).map((x) => x.id);
    expect(ids.filter((x) => x === 'v_old')).toHaveLength(1);
  });

  it('老裸格式经 patch 写回即升级为 envelope', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    await fs.writeFile(join(dir, 'v_up.json'), JSON.stringify(baseTask('v_up')));
    await store.patchScheduledTask('v_up', { enabled: false });
    const raw = JSON.parse(await fs.readFile(join(dir, 'v_up.json'), 'utf-8'));
    expect(typeof raw.version).toBe('number');
    expect(raw.task.enabled).toBe(false);
  });

  it('未来版本文件 → 跳过不读、patch 不写（绝不按旧格式改写让版本倒退）', async () => {
    const store = await import('../../electron/main/scheduledTasks/store');
    const futureBytes = JSON.stringify({ version: 99, task: { id: 'v_future', title: '未来格式' } });
    await fs.writeFile(join(dir, 'v_future.json'), futureBytes);
    expect(await store.getScheduledTask('v_future')).toBeNull();
    expect((await store.listScheduledTasks()).map((x) => x.id)).not.toContain('v_future');
    expect(await store.patchScheduledTask('v_future', { enabled: false })).toBeNull();
    // 文件一个字节没被动过
    expect(await fs.readFile(join(dir, 'v_future.json'), 'utf-8')).toBe(futureBytes);
  });
});
