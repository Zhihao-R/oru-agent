/**
 * 定时任务 AI 工具回归（读/写分离 + 审批门 + 校验单一事实来源）
 *
 * 对应技术设计 judene 12/13/14：
 * - list_scheduled_tasks：mutatesEnvironment=false（只读直执行）、不触发 proposal
 * - manage_scheduled_task：mutatesEnvironment=true（只读挡硬拒的声明位）、写走 proposeOrExecute
 * - create 低于 MIN_INTERVAL 的 spec 被 validateSpec 拒（与 UI 同一函数），且**不**递交提案
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolContext } from '@shared/agent/backend';
import type { ActionProposal } from '@shared/types';

const store = {
  listScheduledTasks: vi.fn(async () => []),
  getScheduledTask: vi.fn(async () => null),
  createScheduledTask: vi.fn(async () => undefined),
  patchScheduledTask: vi.fn(async () => null),
  deleteScheduledTask: vi.fn(async () => undefined),
};
vi.mock('../../electron/main/scheduledTasks/store', () => store);

const proposeOrExecute = vi.fn(
  async (_ctx: ToolContext, _p: ActionProposal, opts: { approvalText: string; execute: () => Promise<unknown> }) =>
    opts.execute(),
);
vi.mock('../../electron/main/agent/agentTools/emitProposal', () => ({ proposeOrExecute }));

vi.mock('../../electron/main/scheduledTasks/notify', () => ({
  emitScheduledTaskState: vi.fn(async () => undefined),
  setScheduledTaskBroadcaster: vi.fn(),
}));

// 默认落点派生要读当前对话的 source——默认让它「查不到对话」（→ 回落 newConversation，与旧行为一致）；
// 渠道默认那条用例里再 mockResolvedValue 带 source。
const getConversationMock = vi.fn(async (): Promise<{ id: string; source?: { platform: string; chatId: string } }> => {
  throw new Error('no such conversation');
});
vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  getConversation: getConversationMock,
}));

const ctx: ToolContext = {
  conversationId: 'c1',
  agentId: 'twin',
  ownerId: 'o',
  approvalMode: 'work',
  usage: 'twinMain',
  abortSignal: new AbortController().signal,
  onProposal: vi.fn(async () => undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  // 持久实现（mockResolvedValue 非 Once）不被 clearAllMocks 清除——统一在此复位，
  // 避免断言失败跳过测试尾部清理时污染后续用例
  store.listScheduledTasks.mockReset().mockResolvedValue([] as never);
});

describe('list_scheduled_tasks（只读）', () => {
  it('mutatesEnvironment=false、不触发 proposal', async () => {
    const { makeListScheduledTasksTool } = await import(
      '../../electron/main/agent/agentTools/scheduledTasks'
    );
    const tool = makeListScheduledTasksTool();
    expect(tool.mutatesEnvironment).toBe(false);
    const r = await tool.execute({}, ctx);
    expect(r.isError).not.toBe(true);
    expect(proposeOrExecute).not.toHaveBeenCalled();
  });
});

describe('manage_scheduled_task（写）', () => {
  it('mutatesEnvironment=true（只读挡硬拒的声明位）', async () => {
    const { makeManageScheduledTaskTool } = await import(
      '../../electron/main/agent/agentTools/scheduledTasks'
    );
    expect(makeManageScheduledTaskTool().mutatesEnvironment).toBe(true);
  });

  it('create 合法（人话时间 daily）→ proposeOrExecute 递交 scheduled-task 提案，批准后落 store', async () => {
    const { makeManageScheduledTaskTool } = await import(
      '../../electron/main/agent/agentTools/scheduledTasks'
    );
    const tool = makeManageScheduledTaskTool();
    await tool.execute(
      {
        action: 'create',
        title: '每日简报',
        prompt: '汇总昨天的笔记',
        schedule: { kind: 'daily', time: '08:00' }, // 模型说人话钟点，代码换算成 minutesOfDay
        runLocation: { kind: 'newConversation' },
      },
      ctx,
    );
    expect(proposeOrExecute).toHaveBeenCalledTimes(1);
    const proposal = proposeOrExecute.mock.calls[0][1];
    expect(proposal.kind).toBe('scheduled-task');
    expect((proposal as { action: string }).action).toBe('create');
    expect(proposal.forceApproval).toBe(true); // work 挡也强制确认
    expect((proposal.draft!.spec as { minutesOfDay: number }).minutesOfDay).toBe(480); // 08:00 → 480，代码换算
    expect(store.createScheduledTask).toHaveBeenCalledTimes(1);
  });

  it('在渠道对话里创建、不指定落点 → 默认 channel，chatId 取自会话 source（推回该渠道）', async () => {
    getConversationMock.mockResolvedValue({ id: 'c1', source: { platform: 'feishu', chatId: 'oc_real_hash' } });
    const { makeManageScheduledTaskTool } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    await makeManageScheduledTaskTool().execute(
      { action: 'create', prompt: '给我讲笑话', schedule: { kind: 'daily', time: '08:00' } }, // 不传 runLocation
      ctx,
    );
    const proposal = proposeOrExecute.mock.calls[0][1];
    expect(proposal.draft!.runLocation).toEqual({ kind: 'channel', platform: 'feishu', chatId: 'oc_real_hash' });
  });

  it('在桌面对话里创建、不指定落点 → 默认 newConversation（会话无 source）', async () => {
    getConversationMock.mockResolvedValue({ id: 'c1' }); // 桌面对话无 source
    const { makeManageScheduledTaskTool } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    await makeManageScheduledTaskTool().execute(
      { action: 'create', prompt: '汇总笔记', schedule: { kind: 'daily', time: '08:00' } },
      ctx,
    );
    const proposal = proposeOrExecute.mock.calls[0][1];
    expect(proposal.draft!.runLocation).toEqual({ kind: 'newConversation' });
  });

  it('显式传 runLocation → 尊重模型选择，不被渠道默认覆盖', async () => {
    getConversationMock.mockResolvedValue({ id: 'c1', source: { platform: 'feishu', chatId: 'oc_real_hash' } });
    const { makeManageScheduledTaskTool } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    await makeManageScheduledTaskTool().execute(
      { action: 'create', prompt: 'x', schedule: { kind: 'daily', time: '08:00' }, runLocation: { kind: 'newConversation' } },
      ctx,
    );
    const proposal = proposeOrExecute.mock.calls[0][1];
    expect(proposal.draft!.runLocation).toEqual({ kind: 'newConversation' });
  });

  it('create 一次性（未来 date+time）→ 落地 spec.at = 该本地时刻、进进行中', async () => {
    const { resolveSchedule } = await import('@shared/scheduledTasks/resolveSchedule');
    const now = Date.now();
    const tom = new Date(now + 24 * 3_600_000);
    const p = (n: number) => String(n).padStart(2, '0');
    const date = `${tom.getFullYear()}-${p(tom.getMonth() + 1)}-${p(tom.getDate())}`;
    const { makeManageScheduledTaskTool } = await import(
      '../../electron/main/agent/agentTools/scheduledTasks'
    );
    const r = await makeManageScheduledTaskTool().execute(
      { action: 'create', prompt: '买电池', schedule: { kind: 'once', date, time: '18:00' } },
      ctx,
    );
    expect(r.isError).not.toBe(true);
    const proposal = proposeOrExecute.mock.calls[0][1];
    const expected = resolveSchedule({ kind: 'once', date, time: '18:00' }, now) as { at: number };
    expect((proposal.draft!.spec as { at: number }).at).toBe(expected.at);
    expect(proposal.draft!.nextRunAt).toBe(expected.at); // 未来 → 有 nextRunAt（进行中），非已结束
  });

  it('create 一次性（过去 date+time）→ isError，text 含填入时刻与当前时间，不递交提案', async () => {
    const { makeManageScheduledTaskTool } = await import(
      '../../electron/main/agent/agentTools/scheduledTasks'
    );
    const r = await makeManageScheduledTaskTool().execute(
      { action: 'create', prompt: '买电池', schedule: { kind: 'once', date: '2020-01-01', time: '09:00' } },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/2020-01-01 09:00/); // 填入时刻
    expect(r.text).toMatch(/已经过去/); // 导向重设
    expect(proposeOrExecute).not.toHaveBeenCalled();
    expect(store.createScheduledTask).not.toHaveBeenCalled();
  });

  it('create 非法 interval（every=0）→ validateSpec 拒、不递交提案', async () => {
    const { makeManageScheduledTaskTool } = await import(
      '../../electron/main/agent/agentTools/scheduledTasks'
    );
    const tool = makeManageScheduledTaskTool();
    const r = await tool.execute(
      {
        action: 'create',
        title: 'x',
        prompt: 'y',
        schedule: { kind: 'interval', every: 0, unit: 'minute' },
      },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(proposeOrExecute).not.toHaveBeenCalled();
    expect(store.createScheduledTask).not.toHaveBeenCalled();
  });

  it('delete → 递交 delete 提案，批准后删整组（组内每条）', async () => {
    // taskId 语义＝组；handleSimple 按 groupId 取组（resolveGroup）→ deleteTaskGroup(cur.groupId) 组内每条删
    store.listScheduledTasks.mockResolvedValue([{ id: 't1', groupId: 't1', title: '周报', createdAt: 1 }] as never);
    const { makeManageScheduledTaskTool } = await import(
      '../../electron/main/agent/agentTools/scheduledTasks'
    );
    const tool = makeManageScheduledTaskTool();
    await tool.execute({ action: 'delete', taskId: 't1' }, ctx);
    const proposal = proposeOrExecute.mock.calls[0][1];
    expect((proposal as { action: string }).action).toBe('delete');
    expect(store.deleteScheduledTask).toHaveBeenCalledWith('t1');
  });

  it('create 多规则（schedules 两条）→ 一个 group、两条 task、频率含两条', async () => {
    const { makeManageScheduledTaskTool } = await import(
      '../../electron/main/agent/agentTools/scheduledTasks'
    );
    const r = await makeManageScheduledTaskTool().execute(
      {
        action: 'create',
        prompt: '汇总',
        schedules: [
          { kind: 'daily', time: '08:00' },
          { kind: 'weekly', weekdays: ['mon'], time: '14:00' },
        ],
        runLocation: { kind: 'newConversation' },
      },
      ctx,
    );
    expect(r.isError).not.toBe(true);
    expect(store.createScheduledTask).toHaveBeenCalledTimes(2); // 两条同组 task
    const proposal = proposeOrExecute.mock.calls[0][1] as { rules?: unknown[] };
    expect(proposal.rules).toHaveLength(2);
    expect(r.text).toMatch(/每天 08:00/);
    expect(r.text).toMatch(/14:00/);
  });

  it('create interval 缺 stopAfterRuns → 强制次数拒、不递交提案', async () => {
    const { makeManageScheduledTaskTool } = await import(
      '../../electron/main/agent/agentTools/scheduledTasks'
    );
    const r = await makeManageScheduledTaskTool().execute(
      { action: 'create', prompt: 'y', schedule: { kind: 'interval', every: 5, unit: 'minute' } },
      ctx,
    );
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/次数/);
    expect(proposeOrExecute).not.toHaveBeenCalled();
    expect(store.createScheduledTask).not.toHaveBeenCalled();
  });

  // ---- 审批窗内组状态漂移：execute 闭包不得沿用 propose 时刻快照（await 后承重判断必须重读）----

  const baseTask = {
    id: 't1',
    groupId: 't1',
    ownerId: 'o',
    agentId: 'twin',
    title: '周报',
    prompt: 'p',
    runLocation: { kind: 'newConversation' },
    spec: { kind: 'daily', minutesOfDay: 480 },
    enabled: true,
    createdBy: 'user',
    nextRunAt: null,
    runCount: 0,
    tz: 'Asia/Shanghai',
    createdAt: 1,
    updatedAt: 1,
  };

  /** 递交提案但不立即执行——捕获 execute 闭包，模拟审批延迟窗 */
  function captureApproval(): { run: () => Promise<{ isError?: boolean; text: string }> } {
    const captured: { run: () => Promise<{ isError?: boolean; text: string }> } = {
      run: async () => {
        throw new Error('proposal not captured');
      },
    };
    proposeOrExecute.mockImplementationOnce(async (_c, _p, opts) => {
      captured.run = opts.execute as typeof captured.run;
      return { text: '已递交' };
    });
    return captured;
  }

  it('update 提案批准前组被删 → 如实报错，不复活任务', async () => {
    store.getScheduledTask.mockResolvedValueOnce(baseTask as never);
    store.listScheduledTasks.mockResolvedValueOnce([baseTask] as never); // propose 时组还在
    const approval = captureApproval();
    const { makeManageScheduledTaskTool } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    await makeManageScheduledTaskTool().execute({ action: 'update', taskId: 't1', title: '新标题' }, ctx);
    // 审批窗内用户删了该组（此后 list 回落默认 mock = 空）
    const r = await approval.run();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/不存在/);
    expect(store.createScheduledTask).not.toHaveBeenCalled(); // 不得复活
  });

  it('update 提案批准前组内首条被删（组已被改）→ 如实报错，不嫁接不静默覆盖', async () => {
    const t2 = { ...baseTask, id: 't2', createdAt: 2, spec: { kind: 'daily', minutesOfDay: 540 } };
    store.getScheduledTask.mockResolvedValueOnce(baseTask as never);
    store.listScheduledTasks.mockResolvedValueOnce([baseTask, t2] as never); // propose 时两条
    const approval = captureApproval();
    const { makeManageScheduledTaskTool } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    await makeManageScheduledTaskTool().execute(
      {
        action: 'update',
        taskId: 't1',
        schedules: [
          { kind: 'daily', time: '08:00' },
          { kind: 'daily', time: '09:00' },
        ],
      },
      ctx,
    );
    // 审批窗内 t1 被删，组只剩 t2——用户批准的是「对 [t1,t2] 的修改」，现状已不是那个组，
    // 位置对齐会把 t1 时代的内容嫁接到 t2 的历史上 → 指纹失配必须如实报错
    store.listScheduledTasks.mockResolvedValue([t2] as never);
    const r = await approval.run();
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/被修改|已变化/);
    expect(store.patchScheduledTask).not.toHaveBeenCalled();
    expect(store.createScheduledTask).not.toHaveBeenCalled();
  });

  it('update 提案批准前用户在 UI 给组新增了规则 → 如实报错，不静默删掉新增', async () => {
    store.getScheduledTask.mockResolvedValueOnce(baseTask as never);
    store.listScheduledTasks.mockResolvedValueOnce([baseTask] as never); // propose 时一条
    const approval = captureApproval();
    const { makeManageScheduledTaskTool } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    await makeManageScheduledTaskTool().execute({ action: 'update', taskId: 't1', title: '只改标题' }, ctx);
    // 窗内用户新增了规则 t3（组变两条）——按 propose 快照全量覆盖会把 t3 静默删掉
    const t3 = { ...baseTask, id: 't3', createdAt: 3, spec: { kind: 'daily', minutesOfDay: 600 } };
    store.listScheduledTasks.mockResolvedValue([baseTask, t3] as never);
    const r = await approval.run();
    expect(r.isError).toBe(true);
    expect(store.deleteScheduledTask).not.toHaveBeenCalled(); // t3 不得被静默删
    expect(store.patchScheduledTask).not.toHaveBeenCalled();
  });

  it('pause 提案批准前组被删 → 如实报错，不谎称已暂停', async () => {
    store.listScheduledTasks.mockResolvedValueOnce([baseTask] as never); // propose 时组还在（resolveGroup 取组代表）
    const approval = captureApproval();
    const { makeManageScheduledTaskTool } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    await makeManageScheduledTaskTool().execute({ action: 'pause', taskId: 't1' }, ctx);
    const r = await approval.run(); // 此时组已不存在（默认 mock 空）
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/不存在/);
    expect(store.patchScheduledTask).not.toHaveBeenCalled();
  });

  // ---- M9：组代表条（首条规则）被删后，AI 工具仍须按 groupId 命中组（与 RPC/UI 同口径）----
  // 用户在 ComposeModal 删掉组内首条规则（其 id === groupId），组仍存活（剩余条共享同 groupId）。
  // list 工具按 groupId 列得出该组；旧 update/delete 走 getScheduledTask(groupId) 却落空 → 谎报「找不到」。

  it('delete：组首条规则被删后，按 groupId 仍命中组、删存活条（M9 回归）', async () => {
    const t2 = { ...baseTask, id: 't2', groupId: 'g1', createdAt: 2 };
    store.getScheduledTask.mockResolvedValue(null as never); // 代表条 id=g1 文件已不在
    store.listScheduledTasks.mockResolvedValue([t2] as never);
    const { makeManageScheduledTaskTool } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    const r = await makeManageScheduledTaskTool().execute({ action: 'delete', taskId: 'g1' }, ctx);
    expect(r.isError).not.toBe(true);
    expect(store.deleteScheduledTask).toHaveBeenCalledWith('t2');
  });

  it('update：组首条规则被删后，按 groupId 仍命中组、改存活条（M9 回归）', async () => {
    const t2 = { ...baseTask, id: 't2', groupId: 'g1', createdAt: 2 };
    store.getScheduledTask.mockResolvedValue(null as never);
    store.listScheduledTasks.mockResolvedValue([t2] as never);
    const { makeManageScheduledTaskTool } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    const r = await makeManageScheduledTaskTool().execute({ action: 'update', taskId: 'g1', title: '新标题' }, ctx);
    expect(r.isError).not.toBe(true);
    expect(store.patchScheduledTask).toHaveBeenCalled(); // 改到组内存活条
  });

  it('locationText：channel 落点如实描述，不谎报成「指定对话」（整体验收 2026-07-13 回归）', async () => {
    const { locationText } = await import('../../electron/main/agent/agentTools/scheduledTasks');
    expect(locationText({ kind: 'newConversation' })).toBe('每次新建对话');
    expect(locationText({ kind: 'conversation', id: 'c1' })).toBe('指定对话');
    expect(locationText({ kind: 'channel', platform: 'feishu', chatId: 'oc_1' })).toBe('推送到渠道（飞书）');
    expect(locationText({ kind: 'channel', platform: 'discord', chatId: 'ch_1' })).toBe('推送到渠道（Discord）');
  });
});
