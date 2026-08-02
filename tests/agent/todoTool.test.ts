/**
 * 计划清单工具（S32·G49）：状态模型扩容后的工具契约 + 按对话落盘 + 覆盖时给被抹掉的项留痕。
 *
 * 三件要害：
 *  - 未知 status **如实报错**（此前静默降级成 pending——模型写 blocked 会被悄悄变成「待办」，
 *    比标卡住还省事，正是要堵的漏洞）
 *  - stuck / removed 缺 note **能落库**，只在回执里点名（诚实的那条路不许比撒谎更费劲）
 *  - 开过工 / 卡住过的项被覆盖抹掉 → 自动补一条 removed 留痕，且留痕必须回到回执与 UI 广播里
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import type { AgentTool, ToolContext } from '@shared/agent/backend';
import type { TodoItem } from '@shared/types';
import { TODO_STATUS_META } from '@shared/todo';
import { makeToolContext } from '../helpers/toolContext';
import { sandboxOruDir } from '../helpers/oruDirSandbox';

sandboxOruDir('todo-tool'); // 必须先于任何 await import——paths.ts 加载时固化 ORU_DIR

let tool: AgentTool;
let store: typeof import('../../electron/main/agent/todoStore');
let paths: typeof import('../../electron/main/runtime/paths');

const OWNER = 'o';
const AGENT = 'a';
let convSeq = 0;
let conv = '';

beforeAll(async () => {
  tool = (await import('../../electron/main/agent/agentTools/todo')).makeTodoTool();
  store = await import('../../electron/main/agent/todoStore');
  paths = await import('../../electron/main/runtime/paths');
});

/** 每个用例一条独立对话——磁盘留存是本次改造的重点，用例间不共享盘上状态 */
beforeEach(() => {
  conv = `conv-todo-${++convSeq}`;
  store.__resetTodoStoreForTest();
});

const ctx = (over?: Partial<ToolContext>): ToolContext =>
  makeToolContext({ conversationId: conv, agentId: AGENT, ownerId: OWNER, ...over });

const read = () => store.getTodos(OWNER, AGENT, conv);

describe('todo 工具 · 契约', () => {
  it('覆盖式写入：存进 per-conv 清单、推 UI、回执含各项', async () => {
    const pushed: TodoItem[][] = [];
    const items: TodoItem[] = [
      { content: '查资料', status: 'done' },
      { content: '写草稿', status: 'in_progress' },
      { content: '改第三节', status: 'pending' },
    ];
    const r = await tool.execute({ items }, ctx({ onTodoUpdate: (it) => pushed.push(it) }));
    expect(r.isError).toBeFalsy();
    expect(await read()).toEqual(items);
    expect(pushed).toHaveLength(1);
    expect(r.text).toContain('写草稿');
  });

  it('未知 status → isError，错误可读（点出是哪一项、给出合法值），不落存储', async () => {
    const r = await tool.execute({ items: [{ content: 'x', status: 'blocked' }] }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('blocked');
    expect(r.text).toContain('x');
    expect(r.text).toContain('stuck');
    expect(await read()).toEqual([]);
  });

  it('items 非数组 / 空 content → isError，不落存储', async () => {
    expect((await tool.execute({ items: 'no' }, ctx())).isError).toBe(true);
    expect((await tool.execute({ items: [{ content: '  ', status: 'pending' }] }, ctx())).isError).toBe(true);
    expect(await read()).toEqual([]);
  });

  it('stuck 缺 note：照样落库，只在回执里点名（不返回 isError）', async () => {
    const r = await tool.execute({ items: [{ content: '连数据库', status: 'stuck' }] }, ctx());
    expect(r.isError).toBeFalsy();
    expect(await read()).toEqual([{ content: '连数据库', status: 'stuck' }]);
    expect(r.text).toContain('连数据库');
    expect(r.text).toContain('没说原因');
  });

  it('stuck 带 note：回执带上原因、不再点名', async () => {
    const r = await tool.execute(
      { items: [{ content: '连数据库', status: 'stuck', note: '缺测试库密码' }] },
      ctx(),
    );
    expect(await read()).toEqual([{ content: '连数据库', status: 'stuck', note: '缺测试库密码' }]);
    expect(r.text).toContain('缺测试库密码');
    expect(r.text).not.toContain('没说原因');
  });

  it('回执用状态名而不是符号（模型要写回的就是这些枚举，符号没有对照表）', async () => {
    const r = await tool.execute(
      {
        items: [
          { content: 'p', status: 'pending' },
          { content: 's', status: 'stuck', note: 'why' },
          { content: 'd', status: 'done' },
        ],
      },
      ctx(),
    );
    expect(r.text).toContain('[pending] p');
    expect(r.text).toContain('[stuck] s —— why');
    expect(r.text).toContain('[done] d');
    expect(r.text).not.toContain(TODO_STATUS_META.stuck.mark); // 符号只给卡片，不进模型侧文本
  });

  it('只写不读：不带 items 调用如实报错，且不动已有清单（读模式已删，每轮注入已覆盖可见性）', async () => {
    await tool.execute({ items: [{ content: '写草稿', status: 'in_progress' }] }, ctx());
    const r = await tool.execute({}, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toContain('items');
    expect(await read()).toEqual([{ content: '写草稿', status: 'in_progress' }]);
  });
});

describe('todo 工具 · 覆盖时留痕', () => {
  it('进行中的项被抹掉 → 补出 removed 留痕，且出现在回执与 UI 广播里', async () => {
    const pushed: TodoItem[][] = [];
    const c = ctx({ onTodoUpdate: (it) => pushed.push(it) });
    await tool.execute({ items: [{ content: '改第三节', status: 'in_progress' }] }, c);
    const r = await tool.execute({ items: [{ content: '换个思路重写', status: 'pending' }] }, c);

    expect(await read()).toEqual([
      { content: '换个思路重写', status: 'pending' },
      { content: '改第三节', status: 'removed' },
    ]);
    expect(r.text).toContain('改第三节'); // 回执用合并后的清单，不是模型传进来的原始数组
    expect(pushed.at(-1)).toEqual(await read()); // UI 拿到的也是合并后的
    // 但不为这条系统代记的留痕点名——模型没做过这个标记，且它会一直留在清单里，每轮点一次名
    expect(r.text).not.toContain('没说原因');
  });

  it('留痕项不会在后续每次调用的回执里被反复点名', async () => {
    await tool.execute({ items: [{ content: '改第三节', status: 'in_progress' }] }, ctx());
    await tool.execute({ items: [{ content: '换个思路', status: 'pending' }] }, ctx()); // 补出留痕
    const r = await tool.execute({ items: [{ content: '换个思路', status: 'done' }] }, ctx());
    expect(await read()).toContainEqual({ content: '改第三节', status: 'removed' });
    expect(r.text).not.toContain('没说原因');
  });

  it('卡住的项被抹掉 → 同样留痕（它也「开过工」）', async () => {
    await tool.execute({ items: [{ content: '连数据库', status: 'stuck', note: '缺密码' }] }, ctx());
    await tool.execute({ items: [{ content: '别的活', status: 'pending' }] }, ctx());
    expect(await read()).toContainEqual({ content: '连数据库', status: 'removed' });
  });

  it('待办项 / 已完成项被抹掉 → 不留痕（正常改计划、事已做完）', async () => {
    await tool.execute(
      {
        items: [
          { content: '待办的', status: 'pending' },
          { content: '做完的', status: 'done' },
        ],
      },
      ctx(),
    );
    await tool.execute({ items: [{ content: '新计划', status: 'pending' }] }, ctx());
    expect(await read()).toEqual([{ content: '新计划', status: 'pending' }]);
  });

  it('跨两次调用：已有 note 的 removed 项不被冲成空', async () => {
    await tool.execute({ items: [{ content: '砍掉的活', status: 'removed', note: '需求取消了' }] }, ctx());
    await tool.execute({ items: [{ content: '别的活', status: 'pending' }] }, ctx());
    expect(await read()).toContainEqual({ content: '砍掉的活', status: 'removed', note: '需求取消了' });
  });
});

describe('todo 工具 · 按对话落盘', () => {
  it('写入后清空内存再读，拿得回同一份（模拟重启）', async () => {
    const items: TodoItem[] = [{ content: '写草稿', status: 'in_progress' }];
    await tool.execute({ items }, ctx());
    store.__resetTodoStoreForTest(); // 只清内存，不碰磁盘
    expect(await read()).toEqual(items);
  });

  it('清单落在对话自己的文件里；clearTodos 后文件不存在、读到空', async () => {
    await tool.execute({ items: [{ content: 'x', status: 'pending' }] }, ctx());
    const file = paths.conversationTodoFile(OWNER, AGENT, conv);
    expect(existsSync(file)).toBe(true);

    await store.clearTodos(OWNER, AGENT, conv);
    expect(existsSync(file)).toBe(false);
    store.__resetTodoStoreForTest();
    expect(await read()).toEqual([]);
  });

  it('两条对话各存各的', async () => {
    await tool.execute({ items: [{ content: 'A 的活', status: 'pending' }] }, ctx());
    const other = `${conv}-other`;
    await tool.execute({ items: [{ content: 'B 的活', status: 'pending' }] }, ctx({ conversationId: other }));
    expect(await read()).toEqual([{ content: 'A 的活', status: 'pending' }]);
    expect(await store.getTodos(OWNER, AGENT, other)).toEqual([{ content: 'B 的活', status: 'pending' }]);
  });
});
