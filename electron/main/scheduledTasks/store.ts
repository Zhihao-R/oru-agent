/**
 * 定时任务持久化
 * - meta: ~/.oru/users/<ownerId>/scheduled-tasks/<id>.json
 *
 * 照 tasks/store.ts 范式：单一串行写队列 + tmp+rename 原子写；所有 read-modify-write 整块
 * 在 enqueue 闭包内（绝不锁外读再写回，避免并发覆盖）；hydrate 给老数据补默认字段。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PendingFire, ScheduledRunRecord, ScheduledTask } from '@shared/types';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { currentTimeZone, isSpentAfterRun } from './schedule';
import { scheduledTasksDir } from '../runtime/paths';
import { createWriteQueue } from '../runtime/atomicStore';
import { makeVersionedCodec } from '../runtime/versionedRecord';

// 串行所有写 + 原子写——避免 RMW 撕裂、断电安全
const { enqueue, writeAtomic } = createWriteQueue();

/** 运行记录（G45）保留上限：足够回溯近况、又不让 meta 文件无界膨胀。 */
export const MAX_RUN_HISTORY = 30;

// ─── 格式版本（S06·G128）─────────────────────────────────────────
// v1（无 version）：裸 ScheduledTask；v2：envelope { version, task }。字段级演进照旧走
// hydrate 补默认（只对「加字段」等价），版本号管结构级演进。封套原语共享自 runtime/versionedRecord。
const codec = makeVersionedCodec<ScheduledTask>({
  baselineVersion: 1,
  chain: [(prev) => ({ version: 2, task: prev })],
  field: 'task',
  label: 'scheduledTasks',
});

/**
 * 读一个任务文件到裸 task（读时迁移 + 迁移前原样副本）。
 * 未来版本 → null（跳过不读、绝不按旧格式改写让版本倒退）；JSON 损坏照旧抛给调用方兜。
 */
async function readTaskFile(path: string): Promise<Partial<ScheduledTask> | null> {
  const rawText = await fs.readFile(path, 'utf-8');
  return codec.read(path, rawText);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(scheduledTasksDir(getCurrentOwnerId()), { recursive: true });
}

function metaFile(id: string): string {
  return join(scheduledTasksDir(getCurrentOwnerId()), `${id}.json`);
}

/**
 * lastRun 旧格式迁移：2026-07 前落盘的是二元 `ok: boolean`，现改为三态 `status`（新增「中止」）。
 * 老数据无 status、只有 ok → ok?'ok':'error'（中止态是新增的，老数据本就不可能有）。
 */
function migrateLastRun(raw: ScheduledTask['lastRun']): ScheduledTask['lastRun'] {
  if (!raw) return raw;
  if ('status' in raw) return raw;
  const legacy = raw as { at: number; ok?: boolean; error?: string; late: boolean };
  return { at: legacy.at, status: legacy.ok ? 'ok' : 'error', error: legacy.error, late: legacy.late };
}

/** 给缺字段的老数据填默认。任何后续扩展字段都在这里写默认值，避免反序列化崩溃。 */
function hydrate(raw: Partial<ScheduledTask> & { id: string }, ownerId: string): ScheduledTask {
  return {
    id: raw.id,
    ownerId: raw.ownerId ?? ownerId,
    agentId: raw.agentId ?? 'twin',
    title: raw.title ?? '定时任务',
    prompt: raw.prompt ?? '',
    runLocation: raw.runLocation ?? { kind: 'newConversation' },
    spec: raw.spec ?? { kind: 'daily', minutesOfDay: 8 * 60 },
    // 组 id（多触发规则聚合层）：老数据/单条无 → 自己 id，天然自成一组
    groupId: raw.groupId ?? raw.id,
    enabled: raw.enabled ?? true,
    createdBy: raw.createdBy ?? 'user',
    stopAfterRuns: raw.stopAfterRuns,
    nextRunAt: raw.nextRunAt ?? null,
    missedAt: raw.missedAt,
    dismissed: raw.dismissed, // 可选，不补默认（缺省即「非用户忽略」）
    runCount: raw.runCount ?? 0,
    lastRun: migrateLastRun(raw.lastRun),
    // 运行记录（G45）：老数据无 → 空账（不回填历史，只从此刻起累积）
    runHistory: raw.runHistory ?? [],
    // 时区锚（S18·G100）：老数据无 tz → 补进程当前时区（不触发重算，见 scheduler 时区核对）
    tz: raw.tz ?? currentTimeZone(),
    // 投递账（S18·G41）：老数据无 pendingFires → 空账
    pendingFires: raw.pendingFires ?? [],
    createdAt: raw.createdAt ?? Date.now(),
    updatedAt: raw.updatedAt ?? Date.now(),
  };
}

/** 测试 hook：外面不要直接调 */
export function __hydrateForTest(raw: Partial<ScheduledTask> & { id: string }): ScheduledTask {
  return hydrate(raw, getCurrentOwnerId());
}

export async function createScheduledTask(task: ScheduledTask): Promise<void> {
  return enqueue(async () => {
    await ensureDir();
    await writeAtomic(metaFile(task.id), codec.serialize(task));
  });
}

/**
 * 锁内 RMW：读当前值 → merge patch → 原子写，整块在 enqueue 内。updatedAt 每次刷新。
 * 所有字段更新（enabled / nextRunAt / missedAt / lastRun / runCount...）都收敛到这一条。
 */
export async function patchScheduledTask(
  id: string,
  patch: Partial<ScheduledTask>,
): Promise<ScheduledTask | null> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const f = metaFile(id);
    if (!existsSync(f)) return null;
    try {
      const raw = await readTaskFile(f);
      if (!raw) return null; // 未来版本：不读不写（版本不倒退）
      const cur = hydrate({ ...raw, id }, ownerId);
      const next: ScheduledTask = { ...cur, ...patch, id: cur.id, updatedAt: Date.now() };
      await writeAtomic(f, codec.serialize(next));
      return next;
    } catch {
      return null;
    }
  });
}

/**
 * 记一次执行：lastRun 落定 + runCount 自增，整块锁内（自增不能读在锁外，否则并发的
 * 手动补执行与到点触发会互相覆盖 runCount——「RMW 整块入锁」铁律）。
 * countsAsRun:false（手动/补执行）只落 lastRun、不进 runCount——否则手动点一下就偷走一次
 * stopAfterRuns 自动配额（advanceNextRun 的停止判定读 runCount）。
 */
export async function recordRun(
  id: string,
  run: NonNullable<ScheduledTask['lastRun']>,
  opts?: { countsAsRun?: boolean },
): Promise<ScheduledTask | null> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const f = metaFile(id);
    if (!existsSync(f)) return null;
    try {
      const raw = await readTaskFile(f);
      if (!raw) return null; // 未来版本：不读不写（版本不倒退）
      const cur = hydrate({ ...raw, id }, ownerId);
      const next: ScheduledTask = {
        ...cur,
        lastRun: run,
        runCount: cur.runCount + (opts?.countsAsRun === false ? 0 : 1),
        updatedAt: Date.now(),
      };
      await writeAtomic(f, codec.serialize(next));
      return next;
    } catch {
      return null;
    }
  });
}

/**
 * 锁内 RMW 通用骨架（S18 三个账目原语共用）：读当前值 → 交给 mutate 算下一版 → 原子写，整块在
 * enqueue 内。mutate 返回 null = 不写（no-op）。所有账的增删（recordFire/settleRun/discardFires）
 * 都必是这一形态——patchScheduledTask 的浅 merge 不足以承载「账数组」的原子增删（锁外先 get 再拼数组
 * 是 RMW 撕裂，会与并发结算互相覆盖：见 ideal-gaps.md G41/G43 与技术方案 §4 注）。
 */
async function mutateTask(
  id: string,
  mutate: (cur: ScheduledTask) => ScheduledTask | null,
): Promise<ScheduledTask | null> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const f = metaFile(id);
    if (!existsSync(f)) return null;
    try {
      const raw = await readTaskFile(f);
      if (!raw) return null; // 未来版本：不读不写（版本不倒退）
      const cur = hydrate({ ...raw, id }, ownerId);
      const mutated = mutate(cur);
      if (!mutated) return null;
      const next: ScheduledTask = { ...mutated, updatedAt: Date.now() };
      await writeAtomic(f, codec.serialize(next));
      return next;
    } catch {
      return null;
    }
  });
}

/**
 * 到点落盘（S18·G41）：推进调度游标 ＋ 追加一笔投递账，同一次原子写——Advance 节点「之间没有
 * 崩溃窗口」。fire 是这一拍的 { dueAt, firedAt }；computeAdvance 在**锁内**基于最新 cur 算出新
 * nextRunAt/enabled（不能锁外算好再传固定值——否则用户在 tick 读任务与本次落盘之间暂停/改停止条件，
 * 锁外算出的 enabled:true 会覆盖用户的暂停，违反「RMW 整块入锁」铁律）。
 */
export async function recordFire(
  id: string,
  fire: PendingFire,
  computeAdvance: (cur: ScheduledTask) => { nextRunAt: number | null; enabled: boolean },
): Promise<ScheduledTask | null> {
  return mutateTask(id, (cur) => {
    const advance = computeAdvance(cur);
    return {
      ...cur,
      nextRunAt: advance.nextRunAt,
      enabled: advance.enabled,
      pendingFires: [...(cur.pendingFires ?? []), fire],
    };
  });
}

/**
 * 执行结算（S18·G43 单点）：lastRun 落定 ＋ 销掉当前全部投递账 ＋ 计次，一次原子写。
 * 计次规则：本批销掉的到点账 ≥ 1 才 runCount+1（合并的多拍计一）；纯手动批（无账）计 0。
 * clearMissed：late 场景执行成功后连带清 missedAt（错过区那一条被这次执行消化）。
 */
export async function settleRun(
  id: string,
  run: NonNullable<ScheduledTask['lastRun']>,
  opts?: { clearMissed?: boolean; conversationId?: string },
): Promise<ScheduledTask | null> {
  return mutateTask(id, (cur) => {
    const clearedFires = (cur.pendingFires ?? []).length;
    const runCount = cur.runCount + (clearedFires >= 1 ? 1 : 0);
    // 终态停用收敛到结算单点（与 runCount+1 同源）：once 跑过即停、stopAfterRuns 到顶即停。
    // fire 路径经 deferDisable 推迟了停用（见 scheduler.fireDueTask），在此落定，避免执行体重验
    // 把「fire 提前翻的 enabled:false」误判成用户暂停（S18 critical）。
    const enabled = isSpentAfterRun(cur, runCount) ? false : cur.enabled;
    // 运行记录（G45）：结算单点追加一笔（新→旧，截到上限）——历次产出从此可回溯、可跳去看。
    const record: ScheduledRunRecord = {
      at: run.at,
      status: run.status,
      late: run.late,
      conversationId: opts?.conversationId,
    };
    const runHistory = [record, ...(cur.runHistory ?? [])].slice(0, MAX_RUN_HISTORY);
    return {
      ...cur,
      lastRun: run,
      runCount,
      enabled,
      runHistory,
      pendingFires: [],
      ...(opts?.clearMissed ? { missedAt: undefined } : {}),
    };
  });
}

/**
 * 开跑前重验失败的丢弃（S18）：清全部投递账、不计次、不落 lastRun——结算滞后多投出去的一拍
 * （删除/暂停/已跑满）在这里被兜住，不留孤账。
 */
export async function discardFires(id: string): Promise<void> {
  await mutateTask(id, (cur) => ({ ...cur, pendingFires: [] }));
}

/**
 * 开机对账收编「已投递未结算」的残留账（S18·崩溃窗口）：pendingFires 非空即上次投递后崩在结算前。
 * 一次原子写销账，并按重验结果决定是否标错过——任务仍有效（enabled 且未跑满）→ missedAt 取账中
 * 最新 dueAt（错过记录接替账）；已跑满/暂停/结束的残留账静默销掉、不报错过。空账 → no-op（返 null）。
 */
export async function reconcileFires(id: string): Promise<ScheduledTask | null> {
  return mutateTask(id, (cur) => {
    const fires = cur.pendingFires ?? [];
    if (fires.length === 0) return null;
    const stillValid = cur.enabled && (cur.stopAfterRuns == null || cur.runCount < cur.stopAfterRuns);
    const latestDue = Math.max(...fires.map((f) => f.dueAt));
    return {
      ...cur,
      pendingFires: [],
      ...(stillValid ? { missedAt: latestDue } : {}),
    };
  });
}

export async function getScheduledTask(id: string): Promise<ScheduledTask | null> {
  const ownerId = getCurrentOwnerId();
  const f = metaFile(id);
  if (!existsSync(f)) return null;
  try {
    const raw = await readTaskFile(f);
    return raw ? hydrate({ ...raw, id }, ownerId) : null;
  } catch {
    return null;
  }
}

export async function listScheduledTasks(): Promise<ScheduledTask[]> {
  const ownerId = getCurrentOwnerId();
  const dir = scheduledTasksDir(ownerId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: ScheduledTask[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const parsed = await readTaskFile(join(dir, f));
      if (!parsed?.id) continue;
      out.push(hydrate({ ...parsed, id: parsed.id }, ownerId));
    } catch {
      // 单个文件解析失败不阻断
    }
  }
  return out;
}

export async function deleteScheduledTask(id: string): Promise<void> {
  return enqueue(async () => {
    try {
      await fs.unlink(metaFile(id));
    } catch {
      // 已不存在视作成功
    }
  });
}
