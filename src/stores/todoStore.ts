/**
 * 通用 todo（计划清单，S32·G49）渲染端态——按对话存 AI 的工作计划，overwrite 覆盖式。
 * 纯展示：随 chat.todo 广播更新，进程/连接丢了无妨（AI 下次更新会重推，且不影响任何判定）。
 */
import { create } from 'zustand';
import type { TodoItem } from '@shared/types';

type TodoState = {
  byConv: Record<string, TodoItem[]>;
  setTodos: (conversationId: string, items: TodoItem[]) => void;
};

export const useTodoStore = create<TodoState>((set) => ({
  byConv: {},
  setTodos: (conversationId, items) =>
    set((s) => ({ byConv: { ...s.byConv, [conversationId]: items } })),
}));

// 空清单回落的模块级常量：选择器返回值必须引用稳定——zustand 按 Object.is 判变更，
// 内联 `?? []` 每次造新引用会让 useSyncExternalStore 陷入 setState 死循环（React #185，
// 实测整屏白掉）。选择器收进 store，组件不再内联写。
const EMPTY_TODOS: readonly TodoItem[] = [];

export const selectTodoItems =
  (conversationId: string) =>
  (s: TodoState): readonly TodoItem[] =>
    s.byConv[conversationId] ?? EMPTY_TODOS;
