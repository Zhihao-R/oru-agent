/**
 * 计划清单取初值（S32·G49）——渲染层切对话 / 连上时拉一次当前清单，之后靠 chat.todo 广播增量。
 * 清单按对话落盘、活过重启，没有这条通道用户屏幕上就是空的（而模型每轮都看得见它）。
 */
import type { RegistrySlice } from './types';
import { getTodos } from '../../agent/todoStore';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';

export const todoHandlers = {
  'chat.todo.list': async (req, { reply }) => {
    const items = await getTodos(getCurrentOwnerId(), req.agentId, req.conversationId);
    reply(req.reqId, { type: 'chat.todo', conversationId: req.conversationId, items });
  },
} satisfies RegistrySlice;
