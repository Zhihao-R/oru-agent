/**
 * 把 taskboard store 的事件接到 ws broadcast 和 agent runner.abortConversation。
 *
 * 启动期由 main/index.ts 调一次 wireTaskboardBroadcast()。
 * store 自己只 emit 事件，不知道 ws/agent 存在。
 *
 * 注：本期只切了 taskboard → ws/agent 的反向依赖；
 *   router.ts 仍有两处直接 import abortConversation——agent/runner
 *   拆事件层是单独 plan。
 */
import { broadcast } from '../ws/server';
import { abortConversation } from '../agent/runner';
import { taskboardEvents } from './events';

let wired = false;

export function wireTaskboardBroadcast(): void {
  if (wired) return;
  wired = true;

  taskboardEvents.on('upsert', (task) => {
    broadcast({ type: 'taskboard.taskUpsert', task });
  });
  taskboardEvents.on('delete', (id) => {
    broadcast({ type: 'taskboard.taskDelete', id });
  });
  taskboardEvents.on('restore', (task) => {
    broadcast({ type: 'taskboard.taskRestore', task });
  });
  taskboardEvents.on('commentConvCreated', ({ task, conversation }) => {
    broadcast({ type: 'taskboard.commentConvCreated', task, conversation });
  });
  taskboardEvents.on('requestAbort', ({ agentId, conversationId }) => {
    abortConversation(agentId, conversationId);
  });
}
