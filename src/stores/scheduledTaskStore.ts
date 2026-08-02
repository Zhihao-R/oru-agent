/**
 * 定时任务前端 store——持有聚合后的 groups（列表/通知/错过/创建卡走它）与展开的 tasks
 * （逐条消费方用：missed→conv 去重等）。写操作走 wsClient.request，统一以回包/广播的
 * scheduledTask.state 为准刷新（不做乐观更新：列表项不多、状态由主进程单一裁决，避免双写闪烁）。
 */
import { create } from 'zustand';
import type {
  ScheduledTask,
  ScheduledTaskScope,
  ScheduleSpec,
  TaskGroup,
  TaskGroupInput,
} from '@shared/types';
import type {
  ScheduledTaskStateEvent,
  ScheduledTaskPreviewResultEvent,
  ServerEventPayload,
} from '@shared/protocol';
import { wsClient } from '@/lib/ws';

type ScheduledTaskState = {
  /** 聚合后的用户可见任务（列表主体）。 */
  groups: TaskGroup[];
  /** 展开的底层 task（逐条消费方：missed→conv 去重、编辑回填单条等）。 */
  tasks: ScheduledTask[];
  /** 当前后台执行中的任务 id（S18·临时态）：inflight RPC 恢复 + started/finished 广播实时增删。 */
  inflight: string[];
  sync: (ev: ScheduledTaskStateEvent) => void;
  refresh: (scope?: ScheduledTaskScope) => Promise<void>;
  /** 拉一次后台执行中的任务 id（页面挂载/重载后恢复「执行中」指示）。 */
  refreshInflight: () => Promise<void>;
  markStarted: (taskId: string) => void;
  markFinished: (taskId: string) => void;
  // 建/改走组写单一入口（createGroup/updateGroup），前端传全量 rules、diff 在主进程做
  createGroup: (input: TaskGroupInput) => Promise<void>;
  updateGroup: (groupId: string, input: TaskGroupInput) => Promise<void>;
  /** ⋯「立即执行」：补跑一次（组内任一规则代表即可，同 prompt）。 */
  run: (taskId: string) => Promise<void>;
  // 组级动作（多触发规则）：启停/删/错过区都对整组
  setGroupEnabled: (groupId: string, enabled: boolean) => Promise<void>;
  deleteGroup: (groupId: string) => Promise<void>;
  runGroupMissed: (groupId: string) => Promise<void>;
  dismissGroupMissed: (groupId: string) => Promise<void>;
};

export const useScheduledTaskStore = create<ScheduledTaskState>((set) => {
  // 写操作统一以服务端回包的 scheduledTask.state 刷新（error 回包则保持原状，由调用方/卡片提示）
  const apply = (res: ServerEventPayload) => {
    if (res.type === 'scheduledTask.state') set({ tasks: res.tasks, groups: res.groups });
  };
  return {
    groups: [],
    tasks: [],
    inflight: [],
    sync: (ev) => set({ tasks: ev.tasks, groups: ev.groups }),
    refresh: async () => {
      // 取全量，前端按组分档（与广播的全量一致）
      apply(await wsClient.request<ScheduledTaskStateEvent>({ type: 'scheduledTask.list', scope: 'all' }));
    },
    refreshInflight: async () => {
      const res = await wsClient.request({ type: 'scheduledTask.inflight' });
      if (res.type === 'scheduledTask.inflight.result') set({ inflight: res.taskIds });
    },
    markStarted: (taskId) =>
      set((s) => (s.inflight.includes(taskId) ? s : { inflight: [...s.inflight, taskId] })),
    markFinished: (taskId) => set((s) => ({ inflight: s.inflight.filter((id) => id !== taskId) })),
    createGroup: async (input) =>
      apply(await wsClient.request({ type: 'scheduledTask.createGroup', input })),
    updateGroup: async (groupId, input) =>
      apply(await wsClient.request({ type: 'scheduledTask.updateGroup', groupId, input })),
    run: async (taskId) => apply(await wsClient.request({ type: 'scheduledTask.run', id: taskId })),
    setGroupEnabled: async (groupId, enabled) =>
      apply(await wsClient.request({ type: 'scheduledTask.setGroupEnabled', groupId, enabled })),
    deleteGroup: async (groupId) =>
      apply(await wsClient.request({ type: 'scheduledTask.deleteGroup', groupId })),
    runGroupMissed: async (groupId) =>
      apply(await wsClient.request({ type: 'scheduledTask.runGroupMissed', groupId })),
    dismissGroupMissed: async (groupId) =>
      apply(await wsClient.request({ type: 'scheduledTask.dismissGroupMissed', groupId })),
  };
});

/** 频率预览：自然语言 + 接下来三次触发时刻（cron 解析单一事实来源在主进程）。 */
export async function fetchPreview(
  spec: ScheduleSpec,
): Promise<{ frequency: string; runs: number[] }> {
  const res = await wsClient.request<ScheduledTaskPreviewResultEvent>({
    type: 'scheduledTask.preview',
    spec,
  });
  if (res.type === 'scheduledTask.preview.result') return { frequency: res.frequency, runs: res.runs };
  return { frequency: '', runs: [] };
}
