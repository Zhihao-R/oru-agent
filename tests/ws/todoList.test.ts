/**
 * chat.todo.list 取初值通道——前端切对话 / 重连时拿回该对话当前的计划清单。
 *
 * 没有这条通道，落盘就只服务了模型：重启后 Oru 每轮都看得见清单、用户屏幕上空空如也，
 * 而且 Oru 会开口引用一份用户看不到的清单（比两边一起忘更糟，那至少是对称的）。
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ServerEventPayload } from '@shared/protocol';
import type { TodoItem } from '@shared/types';
import { sandboxOruDir } from '../helpers/oruDirSandbox';

sandboxOruDir('todo-list-route');

const AGENT = 'a';
let convSeq = 0;
let conv = '';
let owner = '';

let todoHandlers: typeof import('../../electron/main/ws/handlers/todo').todoHandlers;
let store: typeof import('../../electron/main/agent/todoStore');

beforeAll(async () => {
  ({ todoHandlers } = await import('../../electron/main/ws/handlers/todo'));
  store = await import('../../electron/main/agent/todoStore');
  owner = (await import('../../electron/main/identity/getCurrentOwnerId')).getCurrentOwnerId();
});

beforeEach(() => {
  conv = `conv-route-${++convSeq}`;
  store.__resetTodoStoreForTest();
});

async function list(conversationId: string): Promise<ServerEventPayload | undefined> {
  const replies: ServerEventPayload[] = [];
  await todoHandlers['chat.todo.list'](
    { type: 'chat.todo.list', reqId: 'r1', agentId: AGENT, conversationId },
    // handler 只用 reply；broadcast 等其余上下文本条通道不碰
    { reply: (_reqId, ev) => replies.push(ev) } as Parameters<(typeof todoHandlers)['chat.todo.list']>[1],
  );
  return replies[0];
}

describe('chat.todo.list', () => {
  it('主进程有清单、前端为空时，取初值拿回同一份', async () => {
    const items: TodoItem[] = [
      { content: '写草稿', status: 'in_progress' },
      { content: '连数据库', status: 'stuck', note: '缺密码' },
    ];
    await store.setTodos(owner, AGENT, conv, items);
    store.__resetTodoStoreForTest(); // 模拟重启：内存空，靠磁盘兜底
    expect(await list(conv)).toEqual({ type: 'chat.todo', conversationId: conv, items });
  });

  it('没有清单 → 空数组（前端据此不占位）', async () => {
    expect(await list(conv)).toEqual({ type: 'chat.todo', conversationId: conv, items: [] });
  });

  it('切换对话拿到的是该对话自己的清单', async () => {
    const other = `${conv}-other`;
    await store.setTodos(owner, AGENT, conv, [{ content: 'A 的活', status: 'pending' }]);
    await store.setTodos(owner, AGENT, other, [{ content: 'B 的活', status: 'done' }]);
    expect(await list(other)).toMatchObject({ items: [{ content: 'B 的活', status: 'done' }] });
  });
});
