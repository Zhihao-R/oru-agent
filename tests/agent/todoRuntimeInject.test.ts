/**
 * 每轮把计划清单贴回眼前：[运行时上下文] 动态块里带上还悬着的清单。
 *
 * 这是「清单会被忘掉」那个病的正面解——清单写完那一刻在回执里，几十条消息后漂到对话深处、
 * 上下文一压缩就消失。已了结的清单不注入（它在下一轮开始时已被清掉，见 todoSweep）。
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TodoItem } from '@shared/types';
import { sandboxOruDir } from '../helpers/oruDirSandbox';

vi.mock(
  '../../electron/main/projects/store',
  () =>
    ({
      listProjects: vi.fn(async () => ({ projects: [], activeId: null })),
      getProject: vi.fn(async () => {
        throw new Error('no project');
      }),
    }) satisfies Pick<typeof import('../../electron/main/projects/store'), 'listProjects' | 'getProject'>,
);
vi.mock(
  '../../electron/main/agent/mcpPrompt',
  () =>
    ({
      buildUnreachableNote: vi.fn(async () => ''),
    }) satisfies Pick<typeof import('../../electron/main/agent/mcpPrompt'), 'buildUnreachableNote'>,
);

sandboxOruDir('todo-inject'); // 先于任何 await import

const OWNER = 'o';
const AGENT = 'a';
let convSeq = 0;
let conv = '';

let buildRuntimeContext: typeof import('../../electron/main/agent/hooks').buildRuntimeContext;
let store: typeof import('../../electron/main/agent/todoStore');

beforeAll(async () => {
  ({ buildRuntimeContext } = await import('../../electron/main/agent/hooks'));
  store = await import('../../electron/main/agent/todoStore');
  const { setTasksGateway } = await import('../../electron/main/agent/tasksGateway');
  setTasksGateway({
    listTasksForConversation: async () => [],
    markAnnounced: async () => {},
    getLastProgress: async () => null,
    getQuestions: async () => [],
  });
});

beforeEach(() => {
  conv = `conv-inject-${++convSeq}`;
  store.__resetTodoStoreForTest();
});

const inject = (items: TodoItem[]) => store.setTodos(OWNER, AGENT, conv, items);
const context = () => buildRuntimeContext(conv, { ownerId: OWNER, agentId: AGENT });

describe('运行时上下文里的计划清单', () => {
  it('有悬着的项：贴全文 + 点出还剩几项没有结果', async () => {
    await inject([
      { content: '查资料', status: 'done' },
      { content: '写草稿', status: 'in_progress' },
      { content: '改第三节', status: 'pending' },
    ]);
    const ctx = await context();
    expect(ctx).toContain('[当前计划清单]');
    expect(ctx).toContain('[done] 查资料');
    expect(ctx).toContain('[in_progress] 写草稿');
    expect(ctx).toContain('还有 2 项没有结果');
    // 注入块只贴状态，不复述工具描述里的记账规则（两处同义表述迟早漂移）
    expect(ctx).not.toContain('先标 in_progress');
  });

  it('卡住的项算悬着：继续注入，且带上卡在哪', async () => {
    await inject([
      { content: '连数据库', status: 'stuck', note: '缺测试库密码' },
      { content: '查资料', status: 'done' },
    ]);
    const ctx = await context();
    expect(ctx).toContain('[stuck] 连数据库 —— 缺测试库密码');
    expect(ctx).toContain('还有 1 项没有结果');
  });

  it('全部终结（done + removed）：该块为空', async () => {
    await inject([
      { content: '查资料', status: 'done' },
      { content: '砍掉的活', status: 'removed', note: '需求取消' },
    ]);
    expect(await context()).not.toContain('[当前计划清单]');
  });

  it('没有清单：该块为空', async () => {
    expect(await context()).not.toContain('[当前计划清单]');
  });
});
