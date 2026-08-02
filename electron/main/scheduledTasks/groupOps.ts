/**
 * 组写唯一入口（多触发规则）：建/改/删/停一个「用户任务」= 对组内多条底层 ScheduledTask 的批量操作。
 *
 * 硬约束：所有组写只能走这里，内部复用现有 store 原语（create/patch/delete）。禁止各处手写 group by 后逐条改。
 * 调度内核（schedule/scheduler/store 的账目原语）一行不改——本模块只是「一次操作落多条 task」的编排层。
 *
 * 原子性：多文件操作非事务；中途失败 = 部分规则生效、每条自洽。不引入跨文件事务（YAGNI）。
 */
import type { ScheduledTask, ScheduleSpec, TaskGroupInput } from '@shared/types';
import { newScheduledTaskId } from '@shared/ids';
import { deriveTaskTitle } from '@shared/scheduledTasks/deriveTitle';
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTasks,
  patchScheduledTask,
} from './store';
import { assertCreatable, computeNextRun, currentTimeZone, validateSpec } from './schedule';
import { dismissScheduledMissed, runScheduledTaskNow } from './scheduler';

export type TaskGroupMeta = {
  ownerId: string;
  agentId: string;
  createdBy: 'user' | 'agent';
};

/** interval 强制次数（Task 1.3）：放此层而非 validateSpec——validateSpec 是纯 spec 校验、不含 task 级 stopAfterRuns。 */
function assertIntervalHasCount(spec: ScheduleSpec, stopAfterRuns?: number): void {
  if (spec.kind === 'interval' && !(stopAfterRuns != null && stopAfterRuns >= 1)) {
    throw new Error('间隔重复必须设置次数');
  }
}

/** 新增/改 spec 的规则的完整校验：结构 + 未来时刻闸（once 未来）+ interval 强制次数。
 *  导出供 AI 工具在递交提案前逐条预校验（与建组时同一护栏，单一事实源）。 */
export function assertRuleCreatable(spec: ScheduleSpec, stopAfterRuns: number | undefined, now: number): void {
  validateSpec(spec);
  assertCreatable(spec, now); // once 未来时刻闸：AI 误算时间不得悄悄建出「一出生即结束」的死任务（review M4）
  assertIntervalHasCount(spec, stopAfterRuns);
}

const specEqual = (a: ScheduleSpec, b: ScheduleSpec): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

function buildTask(
  id: string,
  groupId: string,
  input: TaskGroupInput,
  rule: TaskGroupInput['rules'][number],
  meta: TaskGroupMeta,
  now: number,
): ScheduledTask {
  return {
    id,
    groupId,
    ownerId: meta.ownerId,
    agentId: meta.agentId,
    title: deriveTaskTitle(input.title, input.prompt), // 留空 = prompt 前 20 字自动命名（打磨 6b）
    prompt: input.prompt,
    runLocation: input.runLocation,
    spec: rule.spec,
    enabled: true,
    createdBy: meta.createdBy,
    stopAfterRuns: rule.stopAfterRuns,
    nextRunAt: computeNextRun(rule.spec, now, now),
    runCount: 0,
    tz: currentTimeZone(),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 建组：先全量校验每条规则（有一条不合法则整组不落，避免建出半截组），再逐条 createScheduledTask。
 * groupId = 首条 rule 的 task id——与「单条自成一组 groupId=自己 id」不变量、legacy/AI 单建路径完全一致。
 */
export async function createTaskGroup(input: TaskGroupInput, meta: TaskGroupMeta): Promise<string> {
  if (input.rules.length === 0) throw new Error('至少需要一条触发规则');
  const now = Date.now();
  for (const rule of input.rules) assertRuleCreatable(rule.spec, rule.stopAfterRuns, now);

  const ids = input.rules.map(() => newScheduledTaskId());
  const groupId = ids[0];
  // createdAt 用 now+i：让组内规则按用户填入顺序稳定排序（聚合/回填不漂移），interval 网格原点偏移 <ms 可忽略
  for (let i = 0; i < input.rules.length; i += 1) {
    await createScheduledTask(buildTask(ids[i], groupId, input, input.rules[i], meta, now + i));
  }
  return groupId;
}

/**
 * 改组：读组内现有 tasks，与 input.rules **按 taskId 对齐** diff（绝不按下标——下标是位置身份，
 * 用户删中间一条或调顺序会把 A 规则的 runCount/历史/游标嫁接到 B）。
 * - 带 taskId 且组内存在 → patch（改了 spec 才重算 nextRunAt；一致性字段一律刷）。
 * - 无 taskId / taskId 不在组内 → 新增。
 * - 组内 taskId 不在 input.rules → 删。
 */
export async function updateTaskGroup(groupId: string, input: TaskGroupInput): Promise<void> {
  if (input.rules.length === 0) throw new Error('至少需要一条触发规则');
  const now = Date.now();
  const existing = (await listScheduledTasks()).filter((t) => t.groupId === groupId);
  // update 语义不含 create：组不存在（如审批窗内被删）就报错，绝不静默重建——
  // 重建会经 inheritMeta 回落空 ownerId，等于「复活」一条身份残缺的任务。
  if (existing.length === 0) throw new Error('定时任务组不存在（可能已被删除）');
  const byId = new Map(existing.map((t) => [t.id, t]));
  const keep = new Set<string>();

  for (const rule of input.rules) {
    const cur = rule.taskId ? byId.get(rule.taskId) : undefined;
    if (cur) {
      keep.add(cur.id);
      // interval 强制次数：无论改没改 spec，最终态是 interval 就必须有次数（不变量，非增量）
      assertIntervalHasCount(rule.spec, rule.stopAfterRuns);
      const specChanged = !specEqual(cur.spec, rule.spec);
      // 一致性：title/prompt/runLocation + spec/stopAfterRuns 一律刷成 input 的值
      //（title 清空 = 重新自动命名，与 placeholder「留空则自动命名」语义一致）
      const patch: Partial<ScheduledTask> = {
        title: deriveTaskTitle(input.title, input.prompt),
        prompt: input.prompt,
        runLocation: input.runLocation,
        spec: rule.spec,
        stopAfterRuns: rule.stopAfterRuns,
      };
      if (specChanged) {
        assertCreatable(rule.spec, now); // 改了才校验时刻，否则未改的 once 会被 cur 时刻误伤
        validateSpec(rule.spec);
        // 改了 spec 才重算 nextRunAt（启用态才有下次）。未改 spec 的条不写 nextRunAt——
        // patchScheduledTask 浅 merge 不碰它，不覆盖 recordFire 刚推进的游标（C2 并发）。
        patch.nextRunAt = cur.enabled ? computeNextRun(rule.spec, now, cur.createdAt) : cur.nextRunAt;
      }
      await patchScheduledTask(cur.id, patch);
    } else {
      // 新增规则
      assertRuleCreatable(rule.spec, rule.stopAfterRuns, now);
      const id = newScheduledTaskId();
      keep.add(id);
      await createScheduledTask(buildTask(id, groupId, input, rule, inheritMeta(existing), now));
    }
  }

  for (const t of existing) {
    if (!keep.has(t.id)) await deleteScheduledTask(t.id);
  }
}

/** 新增规则要 owner/agent/createdBy——从组内现有任一条继承（组内一致性契约保证等价）。 */
function inheritMeta(existing: ScheduledTask[]): TaskGroupMeta {
  const head = existing[0];
  return {
    ownerId: head?.ownerId ?? '',
    agentId: head?.agentId ?? 'twin',
    createdBy: head?.createdBy ?? 'user',
  };
}

/** 启停整组：组内每条翻 enabled；resume 时重算 nextRunAt（复用单条 setEnabled 口径）。 */
export async function setTaskGroupEnabled(groupId: string, enabled: boolean): Promise<void> {
  const now = Date.now();
  const existing = (await listScheduledTasks()).filter((t) => t.groupId === groupId);
  for (const t of existing) {
    await patchScheduledTask(
      t.id,
      enabled ? { enabled: true, nextRunAt: computeNextRun(t.spec, now, t.createdAt) } : { enabled: false },
    );
  }
}

/** 删整组：组内每条删。 */
export async function deleteTaskGroup(groupId: string): Promise<void> {
  const existing = (await listScheduledTasks()).filter((t) => t.groupId === groupId);
  for (const t of existing) await deleteScheduledTask(t.id);
}

/** 错过区组级「执行」：组内每条 missedAt!=null 的补跑（走既有 runTaskNow）。也是组写、纳入本入口。 */
export async function runGroupMissed(groupId: string): Promise<void> {
  const existing = (await listScheduledTasks()).filter((t) => t.groupId === groupId);
  for (const t of existing) {
    if (t.missedAt != null) await runScheduledTaskNow(t.id);
  }
}

/** 错过区组级「忽略」：组内每条 missedAt!=null 的忽略（走既有 dismissMissed）。 */
export async function dismissGroupMissed(groupId: string): Promise<void> {
  const existing = (await listScheduledTasks()).filter((t) => t.groupId === groupId);
  for (const t of existing) {
    if (t.missedAt != null) await dismissScheduledMissed(t.id);
  }
}
