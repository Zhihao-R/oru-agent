/**
 * 定时任务的用户发起 RPC 逻辑（清单聚合 / 预览）。
 *
 * 建/改/删/启停一律走组写唯一入口 groupOps（见 ws/handlers/scheduledTasks.ts）——用户在 UI 里
 * 建/改自己的定时任务不走审批（用户就是操作者）；Oru 在对话里写才走审批（见 agentTools）。
 * 清单聚合与广播都经 buildScheduledStatePayload 单一 helper（带 groups）。
 */
import type { ScheduledTaskScope, ScheduleSpec, TaskGroup } from '@shared/types';
import type { ScheduledTaskStateEvent } from '@shared/protocol';
import { isGroupActive, isGroupEnded } from '@shared/scheduledTasks/group';
import { listScheduledTasks } from './store';
import { groupTasks } from './groupTasks';
import { describeSpec, previewNextRuns, validateSpec } from './schedule';

/** 组层 scope 过滤（review M2）：多规则组「一活一满」不再被拆进 active/ended 两区。 */
export function filterGroupsByScope(
  groups: TaskGroup[],
  scope: ScheduledTaskScope = 'active',
): TaskGroup[] {
  switch (scope) {
    case 'all':
      return groups;
    case 'missed':
      return groups.filter((g) => g.missedAt != null);
    case 'ended':
      return groups.filter(isGroupEnded);
    case 'active':
    default:
      return groups.filter(isGroupActive);
  }
}

/**
 * 广播/回包单一 helper（review M1）：scheduledTask.state 有三条构造路径（list 回包、写操作后
 * pushScheduledTaskState、notify 主动广播），全收进这里，一律带 groups——否则漏一条会让「任务触发后
 * 前端 groups 刷空、退回按底层 task 拆行」只在特定同步时机复现、极难测。
 * tasks 是被选中组的展开底层 task（逐条消费方用）；groups 是聚合后的用户可见任务。
 */
export async function buildScheduledStatePayload(
  scope: ScheduledTaskScope = 'all',
): Promise<ScheduledTaskStateEvent> {
  const all = await listScheduledTasks();
  const groups = filterGroupsByScope(groupTasks(all), scope);
  const kept = new Set(groups.map((g) => g.groupId));
  const tasks = all.filter((t) => kept.has(t.groupId));
  return { type: 'scheduledTask.state', tasks, groups };
}

/** 频率预览：自然语言 + 接下来三次。非法 spec throw（router 转「无法解析」）。
 *  interval 以「此刻创建」为网格原点（createdAt=now）——预览即「若现在创建会怎样」。 */
export function preview(
  spec: ScheduleSpec,
  t: (key: string, params?: Record<string, unknown>) => string,
): { frequency: string; runs: number[] } {
  validateSpec(spec);
  const now = Date.now();
  return { frequency: describeSpec(spec, t), runs: previewNextRuns(spec, now, 3, now) };
}
