/**
 * 了结的计划清单在下一轮开始时清掉（删盘 + 广播空清单撤卡）。
 *
 * 判据是「一项悬着的都没有」——全 done、或 done 与 removed 混合都算了结；只要还有一项 stuck
 * 就不清（那件活还没终结、下一轮可能接着做）。触发点在回合开始而非回合结束，见 todoSweep 头注释。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEventPayload } from '@shared/protocol';
import type { TodoItem } from '@shared/types';
import { sandboxOruDir } from '../helpers/oruDirSandbox';

sandboxOruDir('todo-sweep');

const OWNER = 'o';
const AGENT = 'a';
let convSeq = 0;
let conv = '';

let sweepSettledTodos: typeof import('../../electron/main/agent/todoSweep').sweepSettledTodos;
let store: typeof import('../../electron/main/agent/todoStore');

beforeAll(async () => {
  ({ sweepSettledTodos } = await import('../../electron/main/agent/todoSweep'));
  store = await import('../../electron/main/agent/todoStore');
});

beforeEach(() => {
  conv = `conv-sweep-${++convSeq}`;
  store.__resetTodoStoreForTest();
});

async function sweep(items: TodoItem[]): Promise<{ events: ServerEventPayload[]; left: TodoItem[] }> {
  await store.setTodos(OWNER, AGENT, conv, items);
  const events: ServerEventPayload[] = [];
  await sweepSettledTodos({ ownerId: OWNER, agentId: AGENT, convId: conv, emit: (ev) => events.push(ev) });
  store.__resetTodoStoreForTest(); // 读回磁盘，确认清的不只是内存
  return { events, left: await store.getTodos(OWNER, AGENT, conv) };
}

describe('了结的清单在下一轮开始时清掉', () => {
  it('全部 done → 清空并广播空清单（前端据此撤卡）', async () => {
    const { events, left } = await sweep([
      { content: '查资料', status: 'done' },
      { content: '写草稿', status: 'done' },
    ]);
    expect(left).toEqual([]);
    expect(events).toEqual([{ type: 'chat.todo', conversationId: conv, items: [] }]);
  });

  it('done + removed 混合 → 同样算了结', async () => {
    const { events, left } = await sweep([
      { content: '查资料', status: 'done' },
      { content: '砍掉的活', status: 'removed', note: '需求取消' },
    ]);
    expect(left).toEqual([]);
    expect(events).toHaveLength(1);
  });

  it('含一项 stuck → 不清、不广播（那件活还没终结）', async () => {
    const items: TodoItem[] = [
      { content: '查资料', status: 'done' },
      { content: '连数据库', status: 'stuck', note: '缺密码' },
    ];
    const { events, left } = await sweep(items);
    expect(left).toEqual(items);
    expect(events).toEqual([]);
  });

  it('含待办 / 进行中 → 不清', async () => {
    const items: TodoItem[] = [
      { content: '查资料', status: 'done' },
      { content: '写草稿', status: 'in_progress' },
    ];
    expect((await sweep(items)).left).toEqual(items);
  });

  it('本来就没有清单 → 不发无谓的广播', async () => {
    const { events } = await sweep([]);
    expect(events).toEqual([]);
  });

  // 放最后：本例 resetModules + doMock 换掉 store 实例，不让后面的用例受影响
  it('删盘失败也永不抛——回合照常开始，只留一条 warn', async () => {
    vi.resetModules();
    vi.doMock('../../electron/main/agent/todoStore', () => ({
      getTodos: async () => [{ content: '做完的', status: 'done' }],
      clearTodos: async () => {
        throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      },
    }));
    const mocked = await import('../../electron/main/agent/todoSweep');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // 抛了就等于 runChatAndPersist reject → steering 队列 running 永久卡住、该对话再也起不了回合
    await expect(
      mocked.sweepSettledTodos({ ownerId: OWNER, agentId: AGENT, convId: conv, emit: () => {} }),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
    vi.doUnmock('../../electron/main/agent/todoStore');
    vi.resetModules();
  });
});
