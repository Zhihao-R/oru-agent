/**
 * 前端 task store
 * - tasks: 全部见到的 task（按 id）
 * - proposalsByConv: 按 conversationId 列出待决策提案
 * - progressByTask: 每个 task 的最新进度
 * - questionsByTask: 子 agent 反问历史
 * - expandedCards: 哪些 task card 当前是展开态
 */
import { create } from 'zustand';
import type { ActionProposal, ProposalStatus, SubagentTask, TaskProgress, TaskQuestion } from '@shared/types';

type TaskStoreState = {
  tasks: Record<string, SubagentTask>;
  proposalsByConv: Record<string, ActionProposal[]>;
  progressByTask: Record<string, TaskProgress>;
  questionsByTask: Record<string, TaskQuestion[]>;
  expandedCards: Set<string>;
  /** 标记某 task 刚完成（用于 AgentChip 闪绿动画） */
  justFinishedTaskId: string | null;

  addProposal: (proposal: ActionProposal) => void;
  removeProposal: (proposalId: string) => void;
  /** v0.6：proposal.statusChanged 事件推回时更新对应 proposal.status / completedAt / failureMessage */
  updateProposalStatus: (
    proposalId: string,
    status: Exclude<ProposalStatus, 'pending'>,
    completedAt: number | undefined,
    failureMessage?: string,
  ) => void;
  upsertTask: (task: SubagentTask) => void;
  setProgress: (progress: TaskProgress) => void;
  setStatus: (taskId: string, status: SubagentTask['status']) => void;
  addQuestion: (taskId: string, question: TaskQuestion) => void;
  updateQuestion: (taskId: string, question: TaskQuestion) => void;
  markDone: (taskId: string, summary: string) => void;
  markFailed: (taskId: string, errorMessage: string) => void;
  toggleExpanded: (taskId: string) => void;
  setExpanded: (taskId: string, expanded: boolean) => void;
  clearJustFinished: () => void;

  /** 获取 active agent 下"运行中"的最新一条 task（用于 AgentChip 显示） */
  runningTask: () => SubagentTask | null;
  /** 所有 awaiting_user 的 task（用于 EscalationBanner 跨 conv 显示） */
  escalatedTasks: () => SubagentTask[];
};

export const useTaskStore = create<TaskStoreState>((set, get) => ({
  tasks: {},
  proposalsByConv: {},
  progressByTask: {},
  questionsByTask: {},
  expandedCards: new Set<string>(),
  justFinishedTaskId: null,

  addProposal: (proposal) =>
    set((s) => {
      const list = s.proposalsByConv[proposal.conversationId] ?? [];
      return {
        proposalsByConv: {
          ...s.proposalsByConv,
          [proposal.conversationId]: [...list, proposal],
        },
      };
    }),
  removeProposal: (proposalId) =>
    set((s) => {
      const next: Record<string, ActionProposal[]> = {};
      for (const [k, list] of Object.entries(s.proposalsByConv)) {
        const filtered = list.filter((p) => p.id !== proposalId);
        if (filtered.length > 0) next[k] = filtered;
      }
      return { proposalsByConv: next };
    }),
  updateProposalStatus: (proposalId, status, completedAt, failureMessage) =>
    set((s) => {
      const next: Record<string, ActionProposal[]> = {};
      let changed = false;
      for (const [k, list] of Object.entries(s.proposalsByConv)) {
        next[k] = list.map((p) => {
          if (p.id !== proposalId) return p;
          changed = true;
          return { ...p, status, completedAt, failureMessage };
        });
      }
      return changed ? { proposalsByConv: next } : s;
    }),
  upsertTask: (task) => set((s) => ({ tasks: { ...s.tasks, [task.id]: task } })),
  setProgress: (progress) =>
    set((s) => ({ progressByTask: { ...s.progressByTask, [progress.taskId]: progress } })),
  setStatus: (taskId, status) =>
    set((s) => {
      const t = s.tasks[taskId];
      if (!t) return s;
      return { tasks: { ...s.tasks, [taskId]: { ...t, status } } };
    }),
  addQuestion: (taskId, question) =>
    set((s) => {
      const list = s.questionsByTask[taskId] ?? [];
      // 去重：相同 id 的更新
      const filtered = list.filter((q) => q.id !== question.id);
      return {
        questionsByTask: {
          ...s.questionsByTask,
          [taskId]: [...filtered, question],
        },
      };
    }),
  updateQuestion: (taskId, question) =>
    set((s) => {
      const list = s.questionsByTask[taskId] ?? [];
      const idx = list.findIndex((q) => q.id === question.id);
      if (idx < 0) return { questionsByTask: { ...s.questionsByTask, [taskId]: [...list, question] } };
      const next = [...list];
      next[idx] = question;
      return { questionsByTask: { ...s.questionsByTask, [taskId]: next } };
    }),
  markDone: (taskId, summary) =>
    set((s) => {
      const t = s.tasks[taskId];
      if (!t) return s;
      return {
        tasks: {
          ...s.tasks,
          [taskId]: { ...t, status: 'done', summary, finishedAt: Date.now() },
        },
        justFinishedTaskId: taskId,
      };
    }),
  markFailed: (taskId, errorMessage) =>
    set((s) => {
      const t = s.tasks[taskId];
      if (!t) return s;
      return {
        tasks: {
          ...s.tasks,
          [taskId]: { ...t, status: 'failed', errorMessage, finishedAt: Date.now() },
        },
      };
    }),
  toggleExpanded: (taskId) =>
    set((s) => {
      const next = new Set(s.expandedCards);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return { expandedCards: next };
    }),
  setExpanded: (taskId, expanded) =>
    set((s) => {
      const next = new Set(s.expandedCards);
      if (expanded) next.add(taskId);
      else next.delete(taskId);
      return { expandedCards: next };
    }),
  clearJustFinished: () => set({ justFinishedTaskId: null }),

  runningTask: () => {
    const all = Object.values(get().tasks);
    const running = all.filter(
      (t) =>
        t.status === 'running' ||
        t.status === 'pending' ||
        t.status === 'awaiting_twin' ||
        t.status === 'awaiting_user',
    );
    if (running.length === 0) return null;
    running.sort((a, b) => b.startedAt - a.startedAt);
    return running[0];
  },
  escalatedTasks: () => {
    return Object.values(get().tasks).filter((t) => t.status === 'awaiting_user');
  },
}));
