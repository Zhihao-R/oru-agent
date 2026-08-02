/**
 * 任务本地状态。
 *
 * 数据流：
 *   - useTaskboardSync 挂载时拉一次 list({ includeDeleted: true }) → store.hydrate
 *   - 后端广播 taskUpsert / taskDelete / taskRestore → 对应 reducer
 *
 * UI 状态（view / sidebarGroup / filters / selectedTaskId）只在前端持有，不入后端。
 *
 * 派生选择器是纯函数，组件 useTaskboardStore + useMemo 自取。
 */
import { create } from 'zustand';
import type { BoardActorId, BoardTaskMeta, BoardTaskStatus } from '@shared/types';

export type TaskboardView = 'main' | 'recycle-bin';

/**
 * 左侧栏分组：决定主列表显示哪些任务。
 * - all：全部未删除
 * - mine：assignee=you（含全部状态）
 * - oru：assignee=oru（含全部状态）
 * - completed：status=已完成（跨归属）
 * - { kind:'tag', tag }：projectTag 命中
 */
export type SidebarGroup =
  | { kind: 'all' }
  | { kind: 'mine' }
  | { kind: 'oru' }
  | { kind: 'completed' }
  | { kind: 'tag'; tag: string };

export type TaskboardFilters = {
  /** false = 已完成桶仅显示当天完成；true = 全部 */
  showAllCompleted: boolean;
};

const DEFAULT_FILTERS: TaskboardFilters = {
  showAllCompleted: false,
};

const DEFAULT_GROUP: SidebarGroup = { kind: 'all' };

type TaskboardState = {
  tasks: BoardTaskMeta[];
  loaded: boolean;
  view: TaskboardView;
  sidebarGroup: SidebarGroup;
  filters: TaskboardFilters;
  selectedTaskId: string | null;

  hydrate: (list: BoardTaskMeta[]) => void;
  applyUpsert: (task: BoardTaskMeta) => void;
  applyDelete: (id: string) => void;
  applyRestore: (task: BoardTaskMeta) => void;

  setView: (v: TaskboardView) => void;
  setSidebarGroup: (g: SidebarGroup) => void;
  setFilters: (patch: Partial<TaskboardFilters>) => void;
  resetFilters: () => void;
  selectTask: (id: string | null) => void;
};

export const useTaskboardStore = create<TaskboardState>((set) => ({
  tasks: [],
  loaded: false,
  view: 'main',
  sidebarGroup: DEFAULT_GROUP,
  filters: { ...DEFAULT_FILTERS },
  selectedTaskId: null,

  hydrate: (list) =>
    set(() => ({
      tasks: [...list],
      loaded: true,
    })),

  applyUpsert: (task) =>
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { tasks: [...s.tasks, task] };
      const next = s.tasks.slice();
      next[idx] = task;
      return { tasks: next };
    }),

  applyDelete: (id) =>
    set((s) => {
      // 服务端广播 taskDelete 不带完整 task 对象，前端在本地乐观补 deletedAt/preDeleteStatus
      const idx = s.tasks.findIndex((t) => t.id === id);
      if (idx === -1) return s;
      const t = s.tasks[idx];
      if (t.deletedAt) return s; // 已是删除态
      const next = s.tasks.slice();
      next[idx] = {
        ...t,
        deletedAt: Date.now(),
        preDeleteStatus: t.status,
      };
      // 详情面板若开着此 task，自动关
      const selectedTaskId = s.selectedTaskId === id ? null : s.selectedTaskId;
      return { tasks: next, selectedTaskId };
    }),

  applyRestore: (task) =>
    set((s) => {
      const idx = s.tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { tasks: [...s.tasks, task] };
      const next = s.tasks.slice();
      next[idx] = task;
      return { tasks: next };
    }),

  setView: (view) => set({ view }),
  setSidebarGroup: (sidebarGroup) => set({ sidebarGroup, selectedTaskId: null }),
  setFilters: (patch) => set((s) => ({ filters: { ...s.filters, ...patch } })),
  resetFilters: () => set({ filters: { ...DEFAULT_FILTERS } }),
  selectTask: (id) => set({ selectedTaskId: id }),
}));

// dev only: 暴露 store 到 window，方便控制台手动 hydrate 测 UI
if (import.meta.env.DEV) {
  (window as unknown as { __taskboardStore?: typeof useTaskboardStore }).__taskboardStore =
    useTaskboardStore;
}

// ─── 派生选择器（纯函数；组件自己 useMemo）────────────────────────────────

/** 全部"非删除"任务（main 视图基线） */
export function selectActiveTasks(state: Pick<TaskboardState, 'tasks'>): BoardTaskMeta[] {
  return state.tasks.filter((t) => t.deletedAt == null);
}

/** 当前 view 下的任务（main / recycle-bin） */
export function selectTasksForView(state: Pick<TaskboardState, 'tasks' | 'view'>): BoardTaskMeta[] {
  if (state.view === 'recycle-bin') return state.tasks.filter((t) => t.deletedAt != null);
  return selectActiveTasks(state);
}

/** sidebarGroup 是否命中某个任务 */
function passesGroup(t: BoardTaskMeta, g: SidebarGroup): boolean {
  switch (g.kind) {
    case 'all':
      return true;
    case 'mine':
      return t.assignee === 'you';
    case 'oru':
      return t.assignee === 'oru';
    case 'completed':
      return t.status === '已完成';
    case 'tag':
      return t.projectTag === g.tag;
  }
}

/** main 视图 + 应用 sidebarGroup（recycle-bin 视图不应用） */
export function selectVisibleTasks(
  state: Pick<TaskboardState, 'tasks' | 'view' | 'sidebarGroup'>,
): BoardTaskMeta[] {
  const inView = selectTasksForView(state);
  if (state.view === 'recycle-bin') return inView;
  return inView.filter((t) => passesGroup(t, state.sidebarGroup));
}

const STATUS_ORDER: BoardTaskStatus[] = ['待办', '进行中', '待验收', '已完成'];

function sameDay(ts: number, ref: number): boolean {
  const a = new Date(ts);
  const b = new Date(ref);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export type StatusGroup = {
  status: BoardTaskStatus;
  tasks: BoardTaskMeta[];
};

/**
 * 按状态分组；已完成桶按 showAllCompleted 决定是否再过滤"今天 completedAt"。
 *
 * 例外：sidebarGroup === 'completed' 时所有任务都是已完成，桶全展开（绕过当天过滤），
 * 因为这就是"看全量已完成"语义，再过滤就空了。
 *
 * - 待办/进行中/待验收：updatedAt desc
 * - 已完成：completedAt desc（兜底 updatedAt）
 */
export function selectGroupByStatus(
  state: Pick<TaskboardState, 'tasks' | 'view' | 'sidebarGroup' | 'filters'>,
  now: number = Date.now(),
): StatusGroup[] {
  const visible = selectVisibleTasks(state);
  const showAllDone =
    state.filters.showAllCompleted || state.sidebarGroup.kind === 'completed';
  const buckets: Record<BoardTaskStatus, BoardTaskMeta[]> = {
    '待办': [],
    '进行中': [],
    '待验收': [],
    '已完成': [],
  };
  for (const t of visible) {
    if (t.status === '已完成' && !showAllDone) {
      if (t.completedAt == null || !sameDay(t.completedAt, now)) continue;
    }
    buckets[t.status].push(t);
  }
  for (const s of STATUS_ORDER) {
    buckets[s].sort((a, b) => {
      if (s === '已完成') {
        const ta = a.completedAt ?? a.updatedAt;
        const tb = b.completedAt ?? b.updatedAt;
        return tb - ta;
      }
      return b.updatedAt - a.updatedAt;
    });
  }
  return STATUS_ORDER.map((status) => ({ status, tasks: buckets[status] }));
}

/** "已完成"桶被当天过滤剪掉的数量——用于 list-meta 提示 */
export function selectHiddenCompletedCount(
  state: Pick<TaskboardState, 'tasks' | 'view' | 'sidebarGroup' | 'filters'>,
  now: number = Date.now(),
): number {
  if (state.view !== 'main') return 0;
  if (state.sidebarGroup.kind === 'completed') return 0;
  if (state.filters.showAllCompleted) return 0;
  const visible = selectVisibleTasks(state);
  let n = 0;
  for (const t of visible) {
    if (t.status === '已完成' && (t.completedAt == null || !sameDay(t.completedAt, now))) {
      n += 1;
    }
  }
  return n;
}

/** distinct 的 projectTag 列表，按出现频次降序（仅算非删除任务） */
export function selectTagSuggestions(state: Pick<TaskboardState, 'tasks'>): string[] {
  const counts = new Map<string, number>();
  for (const t of state.tasks) {
    if (t.deletedAt != null) continue;
    const tag = (t.projectTag ?? '').trim();
    if (!tag) continue;
    counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);
}

/** sidebar 的各组计数 */
export type SidebarCounts = {
  all: number;
  mine: number;
  oru: number;
  completed: number;
  /** projectTag → count，按频次降序 */
  tags: Array<{ tag: string; count: number }>;
  recycle: number;
};

export function selectSidebarCounts(state: Pick<TaskboardState, 'tasks'>): SidebarCounts {
  const active = state.tasks.filter((t) => t.deletedAt == null);
  let mine = 0;
  let oru = 0;
  let completed = 0;
  const tagCount = new Map<string, number>();
  for (const t of active) {
    if (t.assignee === 'you') mine += 1;
    else if (t.assignee === 'oru') oru += 1;
    if (t.status === '已完成') completed += 1;
    const tag = (t.projectTag ?? '').trim();
    if (tag) tagCount.set(tag, (tagCount.get(tag) ?? 0) + 1);
  }
  const tags = [...tagCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([tag, count]) => ({ tag, count }));
  const recycle = state.tasks.length - active.length;
  return { all: active.length, mine, oru, completed, tags, recycle };
}
