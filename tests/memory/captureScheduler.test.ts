/**
 * captureScheduler 触发逻辑测试（审计 T1：原零覆盖；C3：per-conv 隔离）
 *
 * 重构后：轮数不再由 onUserMessage 累加，而是触发检查时从对话历史直接数「真实用户轮次」。
 * 驱动方式随之改为 mock readHistory（返回可控 ChatMessage[]），round() 往该 conv 历史追加
 * 一条真实 user + 一条 assistant 后调 onAssistantMessage(agentId, conv)。
 *
 * 核心不变量：
 * - 不到轮数阈值不触发 capture
 * - 满阈值（assistant 落盘那刻）即时触发一次 capture，since 参数对
 * - C3：两对话同时到点都各跑各的，不被全局 inFlight 吞掉
 * - 同一对话在途时不重入；在途攒满补抽、用推进后的游标
 * - failed（coveredUntil=null）不推进游标、且 while 不死循环
 * - 历史里的伪 user（带 kind / 系统旁白 / 纯图空文本）不计入轮次
 * - 入闸后重数：游标已覆盖时新触发不足阈值不打 capture（while 而非 do-while）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage } from '@shared/types';

// mock 锚到真实签名（typeof import）——CaptureOutcome / readHistory 变形时这里会红，不裸 as 蒙混
const { runCaptureMock, getOwner, readHistoryMock } = vi.hoisted(() => ({
  runCaptureMock: vi.fn<(typeof import('../../electron/main/memory/capture'))['runCapture']>(),
  getOwner: vi.fn(() => 'owner1'),
  readHistoryMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['readHistory']>(),
}));
vi.mock('../../electron/main/memory/capture', () => ({ runCapture: runCaptureMock }));
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({ getCurrentOwnerId: getOwner }));
vi.mock('../../electron/main/conversations/store', () => ({ readHistory: readHistoryMock }));

import { onAssistantMessage, __resetForTest } from '../../electron/main/memory/captureScheduler';

const AGENT = 'agentA';

// 让 void triggerCapture 的 microtask 链跑完
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

// 每条对话一段可控历史；createdAt 用全局单调时钟自增
let clock = 0;
const histories = new Map<string, ChatMessage[]>();

function mkMsg(conv: string, over: Partial<ChatMessage>): ChatMessage {
  clock += 1;
  return {
    id: `m${clock}`,
    conversationId: conv,
    role: 'user',
    text: 'hi',
    toolCalls: [],
    createdAt: clock,
    done: true,
    ...over,
  };
}

function push(conv: string, over: Partial<ChatMessage>): void {
  const arr = histories.get(conv) ?? [];
  arr.push(mkMsg(conv, over));
  histories.set(conv, arr);
}

/** 模拟完整一轮：真实 user 一条 + assistant 落盘一条 + 触发检查 */
async function round(conv: string, projectIdOverride?: string | null): Promise<void> {
  push(conv, { role: 'user', text: '真实发言' });
  push(conv, { role: 'assistant', text: '回答' });
  onAssistantMessage(AGENT, conv, projectIdOverride);
  await flush();
}

describe('captureScheduler', () => {
  beforeEach(() => {
    clock = 0;
    histories.clear();
    readHistoryMock.mockReset();
    readHistoryMock.mockImplementation(async (_agentId: string, convId: string) => histories.get(convId) ?? []);
    runCaptureMock.mockReset();
    // 默认成功且覆盖到当下——游标跳到最新，while 再数为 0，恰好一次
    runCaptureMock.mockImplementation(async () => ({ kind: 'ok', opsApplied: 1, opsFailed: 0, coveredUntil: clock }));
    __resetForTest();
  });
  afterEach(() => {
    __resetForTest();
  });

  it('不到 3 轮不触发 capture', async () => {
    await round('A');
    await round('A');
    expect(runCaptureMock).not.toHaveBeenCalled();
  });

  it('满 3 轮即时触发一次，since=0，readHistory 收到 agentId', async () => {
    await round('A');
    await round('A');
    expect(runCaptureMock).not.toHaveBeenCalled();
    await round('A');
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    expect(runCaptureMock).toHaveBeenCalledWith('owner1', 'A', 0, null);
    expect(readHistoryMock).toHaveBeenCalledWith(AGENT, 'A');
  });

  it('项目归属三态：override 优先于桌面单例，null 表示明确无项目', async () => {
    // 后台/评论回合的项目来自 task.projectTag，与桌面此刻在看哪个项目无关；
    // 且必须在触发瞬间定住——runCapture 内部多个 await 之后再读全局就可能已被切走
    const { setActiveProjectId } = await import('../../electron/main/agent/activeProject');
    setActiveProjectId('prj_desktop');
    try {
      for (let i = 0; i < 3; i += 1) await round('A', 'prj_task');
      expect(runCaptureMock).toHaveBeenCalledWith('owner1', 'A', 0, 'prj_task');

      runCaptureMock.mockClear();
      for (let i = 0; i < 3; i += 1) await round('B', null);
      expect(runCaptureMock).toHaveBeenCalledWith('owner1', 'B', 0, null);

      runCaptureMock.mockClear();
      for (let i = 0; i < 3; i += 1) await round('C'); // 不给 → 回落桌面单例
      expect(runCaptureMock).toHaveBeenCalledWith('owner1', 'C', 0, 'prj_desktop');
    } finally {
      setActiveProjectId(null);
    }
  });

  it('C3：两对话同时到点都跑，不互相吞掉', async () => {
    let resolveA!: () => void;
    runCaptureMock.mockImplementation((_owner: string, conv: string) => {
      if (conv === 'A')
        return new Promise((r) => (resolveA = () => r({ kind: 'ok', opsApplied: 1, opsFailed: 0, coveredUntil: clock })));
      return Promise.resolve({ kind: 'ok', opsApplied: 1, opsFailed: 0, coveredUntil: clock });
    });
    for (let i = 0; i < 3; i += 1) await round('A'); // A 触发后挂在途
    for (let i = 0; i < 3; i += 1) await round('B');
    expect(runCaptureMock).toHaveBeenCalledWith('owner1', 'A', 0, null);
    expect(runCaptureMock).toHaveBeenCalledWith('owner1', 'B', 0, null);
    resolveA();
  });

  it('在途期间继续聊但不足阈值，跑完不补抽', async () => {
    let resolveA!: () => void;
    const coveredAtCall: number[] = [];
    runCaptureMock.mockImplementation((_owner: string, _conv: string) => {
      const covered = clock; // 快照：覆盖到发起抽取那刻已有的消息
      coveredAtCall.push(covered);
      return new Promise((r) => (resolveA = () => r({ kind: 'ok', opsApplied: 1, opsFailed: 0, coveredUntil: covered })));
    });
    for (let i = 0; i < 3; i += 1) await round('A'); // 触发 A，进入在途
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    await round('A'); // 在途期间只聊 1 轮（被 inFlight 挡）
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    resolveA();
    await flush();
    // 跑完后 while 重数：新增仅 1 轮 < 阈值 → 不补抽
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
  });

  it('failed（空输出/坏 JSON）不推进游标 + while 不死循环（单触发仅一次调用）', async () => {
    const sinceSeen: number[] = [];
    runCaptureMock.mockImplementation((_owner: string, _conv: string, since: number) => {
      sinceSeen.push(since);
      return Promise.resolve({ kind: 'failed', error: 'unparseable-output', coveredUntil: null });
    });
    for (let i = 0; i < 3; i += 1) await round('A'); // 满 3 → 触发一次，failed → break（不死循环）
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    expect(sinceSeen).toEqual([0]);
    // 再聊 3 轮：游标未推进仍 since=0；每条 assistant 触发一次、各自 break，有限次
    for (let i = 0; i < 3; i += 1) await round('A');
    expect(sinceSeen.every((s) => s === 0)).toBe(true);
    expect(runCaptureMock).toHaveBeenCalledTimes(4); // 首触发 + 后 3 轮各一次，均 break
  });

  it('游标推进：第二批只抽上次之后的增量', async () => {
    const sinceSeen: number[] = [];
    let firstCovered = -1;
    runCaptureMock.mockImplementation((_owner: string, _conv: string, since: number) => {
      sinceSeen.push(since);
      const covered = clock;
      if (firstCovered < 0) firstCovered = covered;
      return Promise.resolve({ kind: 'ok', opsApplied: 1, opsFailed: 0, coveredUntil: covered });
    });
    for (let i = 0; i < 3; i += 1) await round('A'); // 第一批：since=0
    for (let i = 0; i < 3; i += 1) await round('A'); // 第二批：since=上一批 coveredUntil
    expect(sinceSeen).toEqual([0, firstCovered]);
  });

  it('在途期间攒满下一批，跑完补抽且用推进后的游标', async () => {
    let resolveA!: () => void;
    let calls = 0;
    const sinceSeen: number[] = [];
    let firstCovered = -1;
    runCaptureMock.mockImplementation((_owner: string, _conv: string, since: number) => {
      sinceSeen.push(since);
      calls += 1;
      if (calls === 1) {
        firstCovered = clock;
        return new Promise((r) => (resolveA = () => r({ kind: 'ok', opsApplied: 1, opsFailed: 0, coveredUntil: firstCovered })));
      }
      return Promise.resolve({ kind: 'ok', opsApplied: 1, opsFailed: 0, coveredUntil: clock });
    });
    for (let i = 0; i < 3; i += 1) await round('A'); // 第一批触发，挂在途，since=0
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i += 1) await round('A'); // 在途期间又聊满 3 轮（被 inFlight 挡）
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    resolveA();
    await flush();
    // 跑完（游标推进）→ 发现在途期间又满阈值 → 补抽，用新游标
    expect(runCaptureMock).toHaveBeenCalledTimes(2);
    expect(sinceSeen).toEqual([0, firstCovered]);
  });

  it('历史里的伪 user（带 kind / 系统旁白 / 纯图空文本）不计入轮次', async () => {
    push('A', { role: 'user', text: '真实发言' }); // 唯一真实用户轮
    push('A', { role: 'user', text: '', kind: undefined }); // 纯图空文本
    push('A', { role: 'user', text: '（系统记：用户拒绝了提案 p1）' }); // 系统旁白
    push('A', { role: 'user', text: '装配 prompt', kind: 'scheduled-trigger' }); // 机器 kind
    push('A', { role: 'assistant', text: '回答' });
    onAssistantMessage(AGENT, 'A');
    await flush();
    expect(runCaptureMock).not.toHaveBeenCalled(); // 只有 1 条真实 user，不足阈值
    // 再补 2 条真实 user → 满 3 → 触发
    push('A', { role: 'user', text: '真实二' });
    push('A', { role: 'user', text: '真实三' });
    push('A', { role: 'assistant', text: '回答' });
    onAssistantMessage(AGENT, 'A');
    await flush();
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
  });

  it('skipped（no-operations，coveredUntil 非 null）推进游标、重数后自然退出、不多抽', async () => {
    // CaptureOutcome 第三型：skipped 但 coveredUntil 非空（capture.ts 的 no-conversation-text /
    // no-operations 路径）——不 break，游标照常推进；推进后重数 < 阈值即退出，不死循环、不多触发。
    runCaptureMock.mockImplementation(async () => ({ kind: 'skipped', reason: 'no-operations', coveredUntil: clock }));
    for (let i = 0; i < 3; i += 1) await round('A');
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    await round('A'); // 游标已推进，仅 1 轮增量 < 阈值 → 不再触发
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
  });

  it('入闸后重数：游标已覆盖时新触发不足阈值不打 capture（while 而非 do-while）', async () => {
    for (let i = 0; i < 3; i += 1) await round('A'); // 触发一次，游标推进到当下
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
    await round('A'); // 游标之后仅 1 轮 < 阈值——do-while 会多打一次，while 不会
    expect(runCaptureMock).toHaveBeenCalledTimes(1);
  });
});
