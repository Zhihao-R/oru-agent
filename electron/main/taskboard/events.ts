/**
 * Taskboard store 的事件总线。
 *
 * store 不直接 import ws/server 和 agent/runner——通过 emit 事件解耦；
 * 由 wireBroadcast.ts 在 main 启动期订阅并转发到 broadcast / abortConversation。
 *
 * 类型安全靠接口断言（不引入 wrapper class）——调用点用 Node 标准 .emit / .on，
 * 同时获得 K extends keyof TaskboardEventMap 的检查。
 */
import { EventEmitter } from 'node:events';
import type { BoardTaskMeta, Conversation } from '@shared/types';

export type TaskboardEventMap = {
  upsert: [task: BoardTaskMeta];
  delete: [id: string];
  restore: [task: BoardTaskMeta];
  commentConvCreated: [payload: { task: BoardTaskMeta; conversation: Conversation }];
  requestAbort: [payload: { agentId: string; conversationId: string }];
};

export interface TaskboardEvents {
  emit<K extends keyof TaskboardEventMap>(event: K, ...args: TaskboardEventMap[K]): boolean;
  on<K extends keyof TaskboardEventMap>(
    event: K,
    listener: (...args: TaskboardEventMap[K]) => void,
  ): this;
}

export const taskboardEvents: TaskboardEvents = new EventEmitter();
