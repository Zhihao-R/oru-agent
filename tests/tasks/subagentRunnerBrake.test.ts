/**
 * 对话级刹车（G17）——cancelTasksForConversation 回归
 *
 * 验五条不变量：
 * 1. 【abort 传导】被取消任务的 backend 会话立刻收到 abort 信号，任务落终态；
 * 2. 【隔离】其他对话的运行中任务不受波及（不 abort、不落终态）；
 * 3. 【bash 复用】task 级后台 bash 经既有 cancelTask 内核清理
 *    （killBashForConversation(task_<id>)，不另写第二份杀进程代码）；
 * 4. 【起跑盲窗】activeTasks 登记先于 runTask 首个 await——启动段（backend 检查 /
 *    git / provisionAgent，可达秒级）内按停也刹得住，任务被截在起跑线上、
 *    backend 会话不得开启；
 * 5. 【刹车静默】对话级刹车取消的任务不写对话内报告卡（PM 拍板：按停后不列被中断
 *    明细）；单独的手动 task.cancel 保持现状——失败报告卡照写。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent, CodeActionProposal, ServerEventPayload } from '@shared/types';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';

// ─── mock 声明（vi.mock 提升至模块顶部；与 subagentRunner.test.ts 同一套桩） ────

vi.mock('../../electron/main/agent/store/agents', () => ({
  getAgent: vi.fn<() => Promise<Agent>>(),
}));

vi.mock('../../electron/main/agent/backends', () => ({
  getBackendFor: vi.fn<() => Promise<AgentBackend>>(),
}));

// appendTaskEvent 供真实 tasks/stream 落盘事件用（这里桩掉，不打真实 store）
vi.mock('../../electron/main/tasks/store', () => ({
  createTask: vi.fn(),
  updateTaskStatus: vi.fn(),
  appendTaskEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../electron/main/tasks/git', () => ({
  recordBaseline: vi.fn(),
  recordEndTag: vi.fn(),
  computeAffectedPaths: vi.fn(),
}));

vi.mock('../../electron/main/git/workflow', () => ({
  ensureFeatureBranch: vi.fn(),
}));

vi.mock('../../electron/main/projects/store', () => ({
  getProject: vi.fn(),
}));

vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: vi.fn(),
  resolveApiKeyForSdk: vi.fn(),
}));

vi.mock('../../electron/main/engine/subprocessEnv', () => ({
  buildSubprocessEnv: vi.fn().mockReturnValue({}),
}));

vi.mock('../../electron/main/agent/capabilities', () => ({
  provisionAgent: vi.fn(),
}));

vi.mock('../../electron/main/conversations/store', () => ({
  appendMessage: vi.fn<() => Promise<void>>(),
  readHistoryForLLM: vi.fn<() => Promise<[]>>().mockResolvedValue([]),
}));

vi.mock('../../electron/main/debug/instrument', () => ({
  instrumentConversation: vi.fn(),
}));

vi.mock('../../electron/main/tasks/askTwinBridge', () => ({
  askTwin: vi.fn(),
  abortPendingAnswers: vi.fn(),
}));

vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: vi.fn().mockReturnValue('test-owner'),
}));

vi.mock('../../electron/main/search/budget', () => ({
  finalizeConversationBudget: vi.fn(),
}));

vi.mock('../../electron/main/ws/router', () => ({
  surfaceProposal: vi.fn(),
  cancelSubagentProposals: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

vi.mock('../../electron/main/deck/pathResolver', () => ({
  deckIndexPath: vi.fn().mockReturnValue('/tmp/deck/index.html'),
}));

vi.mock('../../electron/main/deck/validateDeck', () => ({
  validateDeck: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../electron/main/deck/deckFixPrompts', () => ({
  buildAdvisePrompt: vi.fn().mockReturnValue(''),
  fixProgressText: vi.fn().mockReturnValue(''),
  residualNote: vi.fn().mockReturnValue(''),
}));

vi.mock('../../electron/main/prompts/deckReviewGuard', () => ({
  DECK_REVIEW_GUARD_PROMPT: '',
}));

vi.mock('../../electron/main/proposals/executeBashProposal', () => ({
  killBashForConversation: vi.fn(),
}));

// 注意：tasks/stream 不 mock——用真实 pipeSdkToEventsForTask 消费事件流，abort 传导走真实路径。

import { runTask, cancelTask, cancelTasksForConversation } from '../../electron/main/tasks/subagentRunner';
import { getAgent } from '../../electron/main/agent/store/agents';
import { getBackendFor } from '../../electron/main/agent/backends';
import { createTask, updateTaskStatus } from '../../electron/main/tasks/store';
import { appendMessage as appendConvMessage } from '../../electron/main/conversations/store';
import { provisionAgent } from '../../electron/main/agent/capabilities';
import { instrumentConversation } from '../../electron/main/debug/instrument';
import { killBashForConversation } from '../../electron/main/proposals/executeBashProposal';
import type { SubagentTask } from '@shared/types';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/**
 * 挂起式 backend 桩：runConversation 的事件流一直挂着，直到 abort 信号到来才抛错
 * ——模拟「后台任务正在跑，用户按停」。abort 传导正确时对应 runTask 才会落终态。
 */
function makeHangingBackend(): AgentBackend {
  return {
    backendType: 'openai-compatible',
    toolProtocol: 'native',
    isReady: vi.fn<AgentBackend['isReady']>().mockResolvedValue({ ok: true }),
    runConversation: vi.fn((input: ConversationInput) => {
      const signal = input.abortController?.signal;
      async function* events() {
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) resolve();
          else signal.addEventListener('abort', () => resolve(), { once: true });
        });
        throw new Error('对话已被用户中止');
      }
      return { events: events() };
    }),
    runOneShot: vi.fn(),
    registerTool: vi.fn(),
    unregisterTool: vi.fn(),
  } satisfies AgentBackend;
}

function makeProposal(conversationId: string, id: string): CodeActionProposal {
  return {
    id,
    kind: 'code',
    conversationId,
    title: '测试提案',
    description: '测试',
    risk: 'low',
    rollbackable: true,
    rawPlan: '执行测试任务',
    targetProjectId: null, // 无 git 项目：跳过 baseline/branch，聚焦刹车路径
    status: 'pending',
    profileId: 'project-coder',
    deckContext: null,
  };
}

function makeAgent(): Agent {
  return {
    id: 'agent-1',
    name: 'Oru',
    homePath: '/tmp/agent-home',
    approvalMode: 'work',
    ownerId: 'test-owner',
    language: 'zh',
  } satisfies Agent;
}

// ─── 测试 ─────────────────────────────────────────────────────────────────────

describe('对话级刹车：cancelTasksForConversation', () => {
  const created: SubagentTask[] = [];

  beforeEach(() => {
    vi.clearAllMocks();
    created.length = 0;
    vi.mocked(getAgent).mockResolvedValue(makeAgent());
    vi.mocked(createTask).mockImplementation(async (t: SubagentTask) => {
      created.push(t);
    });
    vi.mocked(updateTaskStatus).mockResolvedValue(undefined);
    vi.mocked(provisionAgent).mockResolvedValue({
      capabilityPrompt: '',
      extraDisallowed: [],
      toolContextPatch: {},
    });
    // 事件流原样透传（真实 instrument 会包一层调试插桩，这里不需要）
    vi.mocked(instrumentConversation).mockImplementation(
      (_backend, _meta, events) => events,
    );
    vi.mocked(getBackendFor).mockResolvedValue(makeHangingBackend());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('只取消目标对话的运行中任务：abort 传导落终态；其他对话的任务照跑；task 级 bash 复用既有清理入口', async () => {
    const pA = runTask({ agentId: 'agent-1', proposal: makeProposal('conv-A', 'prop-A'), emit: vi.fn() });
    const pB = runTask({ agentId: 'agent-1', proposal: makeProposal('conv-B', 'prop-B'), emit: vi.fn() });

    // 等两个任务都进入 running（activeTasks 已登记）
    await vi.waitFor(() => expect(created).toHaveLength(2));
    const taskA = created.find((t) => t.conversationId === 'conv-A')!;
    const taskB = created.find((t) => t.conversationId === 'conv-B')!;
    await vi.waitFor(() =>
      expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(taskA.id, 'running'),
    );
    await vi.waitFor(() =>
      expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(taskB.id, 'running'),
    );

    // 刹 conv-A：恰好取消 taskA
    expect(cancelTasksForConversation('conv-A')).toEqual([taskA.id]);
    await pA; // abort 传导 → 事件流抛错 → runTask 走终态路径后 resolve

    // taskA 落终态：abort 走 catch，被用户取消 → cancelled（不是 failed；用户自己按停不算失败）
    expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(
      taskA.id,
      'cancelled',
      expect.anything(),
    );
    // 反向护栏：被取消的任务不得落 failed
    expect(vi.mocked(updateTaskStatus)).not.toHaveBeenCalledWith(
      taskA.id,
      'failed',
      expect.anything(),
    );
    // task 级后台 bash 走既有 cancelTask 内核清理（同一杀进程入口；动态 import 异步到位）
    await vi.waitFor(() =>
      expect(vi.mocked(killBashForConversation)).toHaveBeenCalledWith(`task_${taskA.id}`),
    );

    // 隔离：taskB 未被波及——仍在跑（promise 未 settle、未落终态）
    let bSettled = false;
    void pB.finally(() => {
      bSettled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(bSettled).toBe(false);
    expect(vi.mocked(updateTaskStatus)).not.toHaveBeenCalledWith(
      taskB.id,
      'cancelled',
      expect.anything(),
    );

    // 清场：把 conv-B 也刹掉，避免悬空 promise 泄漏到别的用例
    expect(cancelTasksForConversation('conv-B')).toEqual([taskB.id]);
    await pB;

    // 刹车静默：两个被刹任务都不写对话内报告卡（手动 task.cancel 的对照见下方用例）
    expect(vi.mocked(appendConvMessage)).not.toHaveBeenCalled();
  });

  it('起跑盲窗也刹得住：登记先于首个 await，启动段按停任务不得开启 backend 会话', async () => {
    // provisionAgent 挂住 = 任务停在启动段（backend 检查已过、正式起跑之前）
    let releaseProvision!: () => void;
    vi.mocked(provisionAgent).mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseProvision = () =>
            resolve({ capabilityPrompt: '', extraDisallowed: [], toolContextPatch: {} });
        }),
    );
    const backend = makeHangingBackend();
    vi.mocked(getBackendFor).mockResolvedValue(backend);

    const p = runTask({ agentId: 'agent-1', proposal: makeProposal('conv-C', 'prop-C'), emit: vi.fn() });
    await vi.waitFor(() => expect(vi.mocked(provisionAgent)).toHaveBeenCalled());

    // 启动段按停：登记若晚于启动段，这里抓空返回 []，任务静默逃逸照常跑完（回归点）
    const cancelled = cancelTasksForConversation('conv-C');
    expect(cancelled).toHaveLength(1);

    releaseProvision();
    await p;

    // 截在起跑线上：backend 会话从未开启；任务落 cancelled 终态；刹车静默——不写对话报告卡
    expect(backend.runConversation).not.toHaveBeenCalled();
    expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(cancelled[0], 'cancelled', expect.anything());
    expect(vi.mocked(appendConvMessage)).not.toHaveBeenCalled();
  });

  it('单独的手动 task.cancel：任务落 cancelled 且写「已取消」报告卡（非失败卡；只有对话级刹车走静默）', async () => {
    const emit = vi.fn<(ev: ServerEventPayload) => void>();
    const p = runTask({ agentId: 'agent-1', proposal: makeProposal('conv-M', 'prop-M'), emit });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const task = created[0];
    await vi.waitFor(() =>
      expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(task.id, 'running'),
    );

    expect(cancelTask(task.id)).toBe(true);
    await p;

    // 手动取消 → cancelled（不是 failed）
    expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(task.id, 'cancelled', expect.anything());
    expect(vi.mocked(updateTaskStatus)).not.toHaveBeenCalledWith(task.id, 'failed', expect.anything());
    // 报告卡照写（非静默），但是「已取消」而非「失败」文案
    expect(vi.mocked(appendConvMessage)).toHaveBeenCalledTimes(1);
    const card = vi.mocked(appendConvMessage).mock.calls[0][2];
    expect(card.text).toContain('已取消');
    expect(card.text).not.toContain('任务失败');
    // 终态事件走 task.statusChanged=cancelled，不广播 task.failed
    // （任务先转 running 会先播一条 statusChanged=running，取末条判终态）
    const statusEvts = emit.mock.calls.map(([ev]) => ev).filter((ev) => ev.type === 'task.statusChanged');
    expect(statusEvts.at(-1)).toMatchObject({ status: 'cancelled' });
    expect(emit.mock.calls.some(([ev]) => ev.type === 'task.failed')).toBe(false);
  });

  it('对话没有运行中任务时返回空数组（幂等，无副作用）', () => {
    expect(cancelTasksForConversation('conv-nothing')).toEqual([]);
    expect(vi.mocked(killBashForConversation)).not.toHaveBeenCalled();
  });

  it('【对照】真实错误（非取消，signal 未 abort）仍落 failed 且写失败卡——防误伤', async () => {
    // backend 事件流立刻抛错（后端挂 / 工具炸），从头到尾没有 abort 信号
    vi.mocked(getBackendFor).mockResolvedValue({
      backendType: 'openai-compatible',
      toolProtocol: 'native',
      isReady: vi.fn<AgentBackend['isReady']>().mockResolvedValue({ ok: true }),
      runConversation: vi.fn(() => {
        async function* events() {
          throw new Error('后端连接炸了');
        }
        return { events: events() };
      }),
      runOneShot: vi.fn(),
      registerTool: vi.fn(),
      unregisterTool: vi.fn(),
    } satisfies AgentBackend);

    const emit = vi.fn<(ev: ServerEventPayload) => void>();
    const p = runTask({ agentId: 'agent-1', proposal: makeProposal('conv-E', 'prop-E'), emit });
    await p;

    const task = created.find((t) => t.conversationId === 'conv-E')!;
    // 真错误 → failed（不是 cancelled），错误信息落盘
    expect(vi.mocked(updateTaskStatus)).toHaveBeenCalledWith(
      task.id,
      'failed',
      expect.objectContaining({ errorMessage: expect.stringContaining('后端连接炸了') }),
    );
    expect(vi.mocked(updateTaskStatus)).not.toHaveBeenCalledWith(task.id, 'cancelled', expect.anything());
    // 失败卡照写 + 广播 task.failed
    const card = vi.mocked(appendConvMessage).mock.calls[0][2];
    expect(card.text).toContain('任务失败');
    expect(emit.mock.calls.some(([ev]) => ev.type === 'task.failed')).toBe(true);
  });
});
