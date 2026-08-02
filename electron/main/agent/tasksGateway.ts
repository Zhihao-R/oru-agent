/**
 * agent/* 访问 tasks/store 的单一注入闸门。
 *
 * 为什么不直接 import：tasks/* 反过来 import agent/*（taskAnnouncer 用 runner / twinBackgroundQuery），
 * agent/* 再直接 import tasks/store 就成环。需要 store 能力的 agent 侧模块——hooks 的运行时上下文、
 * checkTasks 现查工具——都从这里取，由 main 启动期 setTasksGateway 一次性注入。
 * 加第 N 个消费方零成本：不再各开一套 let deps / set / require 的样板。
 */
import type { SubagentTask, TaskQuestion } from '@shared/types';

export type TasksGateway = {
  listTasksForConversation: (convId: string) => Promise<SubagentTask[]>;
  markAnnounced: (taskId: string) => Promise<void>;
  getLastProgress: (taskId: string) => Promise<string | null>;
  getQuestions: (taskId: string) => Promise<TaskQuestion[]>;
};

let gateway: TasksGateway | null = null;

export function setTasksGateway(g: TasksGateway): void {
  gateway = g;
}

export function tasksGateway(): TasksGateway {
  if (!gateway) {
    throw new Error('agent/tasksGateway: setTasksGateway not called — main 启动期未注入 tasks/store');
  }
  return gateway;
}
