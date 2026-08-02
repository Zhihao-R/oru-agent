/**
 * 子任务停滞看门狗回归（S19·G107）。
 *
 * 目标问题：挂死的子任务此前永远显示「进行中」（无任何超时/停滞兜底）。看门狗判据：
 * - 长时间无新活动（流式事件/工具调用刷新计时）→ 判停滞、abort、落 failed（超时失败）。
 * - 但「等主对话答疑 / 等用户」（awaiting_twin/awaiting_user）是合法阻塞、不算停滞——按持久状态豁免。
 *
 * 只测看门狗决策：注入假的运行中任务 + 控制 getTask 的返回，直接驱动一次 tick。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent, SubagentTask } from '@shared/types';
import type { AgentBackend } from '@shared/agent/backend';

vi.mock('../../electron/main/agent/store/agents', () => ({ getAgent: vi.fn<() => Promise<Agent>>() }));
vi.mock('../../electron/main/agent/backends', () => ({ getBackendFor: vi.fn<() => Promise<AgentBackend>>() }));

const storeMock = vi.hoisted(() => ({ status: null as SubagentTask['status'] | null }));
vi.mock('../../electron/main/tasks/store', () => ({
  createTask: vi.fn<() => Promise<void>>(),
  updateTaskStatus: vi.fn<() => Promise<void>>(),
  getTask: vi.fn(async () => (storeMock.status ? { status: storeMock.status } : null)),
}));

vi.mock('../../electron/main/tasks/git', () => ({ recordBaseline: vi.fn(), recordEndTag: vi.fn(), computeAffectedPaths: vi.fn() }));
vi.mock('../../electron/main/git/workflow', () => ({ ensureFeatureBranch: vi.fn() }));
vi.mock('../../electron/main/projects/store', () => ({ getProject: vi.fn() }));
vi.mock('../../electron/main/agent/auth', () => ({ detectAuth: vi.fn(), resolveApiKeyForSdk: vi.fn() }));
vi.mock('../../electron/main/engine/subprocessEnv', () => ({ buildSubprocessEnv: vi.fn().mockReturnValue({}) }));
vi.mock('../../electron/main/agent/capabilities', () => ({ provisionAgent: vi.fn() }));
vi.mock('../../electron/main/conversations/store', () => ({
  appendMessage: vi.fn<() => Promise<void>>(),
  readHistoryForLLM: vi.fn<() => Promise<[]>>().mockResolvedValue([]),
}));
vi.mock('../../electron/main/tasks/stream', () => ({ pipeSdkToEventsForTask: vi.fn() }));
vi.mock('../../electron/main/debug/instrument', () => ({ instrumentConversation: vi.fn() }));
vi.mock('../../electron/main/tasks/askTwinBridge', () => ({ askTwin: vi.fn(), abortPendingAnswers: vi.fn() }));
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({ getCurrentOwnerId: vi.fn().mockReturnValue('test-owner') }));
vi.mock('../../electron/main/search/budget', () => ({ finalizeConversationBudget: vi.fn() }));
vi.mock('../../electron/main/ws/router', () => ({
  surfaceProposal: vi.fn(),
  cancelSubagentProposals: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));
vi.mock('../../electron/main/deck/pathResolver', () => ({ deckIndexPath: vi.fn().mockReturnValue('/tmp/deck/index.html') }));
vi.mock('../../electron/main/deck/validateDeck', () => ({ validateDeck: vi.fn().mockResolvedValue([]) }));
vi.mock('../../electron/main/deck/deckFixPrompts', () => ({
  buildAdvisePrompt: vi.fn().mockReturnValue(''),
  fixProgressText: vi.fn().mockReturnValue(''),
  residualNote: vi.fn().mockReturnValue(''),
}));
vi.mock('../../electron/main/prompts/deckReviewGuard', () => ({ DECK_REVIEW_GUARD_PROMPT: '' }));
vi.mock('../../electron/main/proposals/executeBashProposal', () => ({ killBashForConversation: vi.fn() }));

import {
  __injectActiveTaskForTest,
  __subagentWatchdogTickForTest,
  __isStalledForTest,
} from '../../electron/main/tasks/subagentRunner';

const STALE = Date.now() - 60 * 60 * 1000; // 1 小时前——远超停滞窗
const FRESH = Date.now();

beforeEach(() => {
  storeMock.status = null;
});

describe('子任务停滞看门狗（G107）', () => {
  it('长时间无活动 → 判停滞、abort', async () => {
    storeMock.status = 'running';
    const ac = __injectActiveTaskForTest('t-stall', 'conv1', STALE);
    await __subagentWatchdogTickForTest();
    expect(ac.signal.aborted).toBe(true);
    expect(__isStalledForTest('t-stall')).toBe(true);
  });

  it('刚有活动 → 不判停滞', async () => {
    storeMock.status = 'running';
    const ac = __injectActiveTaskForTest('t-fresh', 'conv1', FRESH);
    await __subagentWatchdogTickForTest();
    expect(ac.signal.aborted).toBe(false);
    expect(__isStalledForTest('t-fresh')).toBe(false);
  });

  it('等用户答疑（awaiting_user）即使久无活动也豁免——合法阻塞不误杀', async () => {
    storeMock.status = 'awaiting_user';
    const ac = __injectActiveTaskForTest('t-waiting', 'conv1', STALE);
    await __subagentWatchdogTickForTest();
    expect(ac.signal.aborted).toBe(false);
    expect(__isStalledForTest('t-waiting')).toBe(false);
  });
});
