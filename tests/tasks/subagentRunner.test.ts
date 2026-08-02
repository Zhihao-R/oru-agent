/**
 * subagentRunner.runTask 后端可用性回归
 *
 * 验一条不变量：project-coder + 非 anthropic backend（配好 key）→ 正常走到 git 操作。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Agent, CodeActionProposal, ServerEventPayload } from '@shared/types';
import type { AgentBackend } from '@shared/agent/backend';

// ─── mock 声明（vi.mock 提升至模块顶部） ──────────────────────────────────────

vi.mock('../../electron/main/agent/store/agents', () => ({
  getAgent: vi.fn<() => Promise<Agent>>(),
}));

// backends：只 mock getBackendFor；backendType 字段由各测试的 stub 自行设置
vi.mock('../../electron/main/agent/backends', () => ({
  getBackendFor: vi.fn<() => Promise<AgentBackend>>(),
}));

vi.mock('../../electron/main/tasks/store', () => ({
  createTask: vi.fn<() => Promise<void>>(),
  updateTaskStatus: vi.fn<() => Promise<void>>(),
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

vi.mock('../../electron/main/tasks/stream', () => ({
  pipeSdkToEventsForTask: vi.fn(),
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

// keepAwake：runTask 登记处 acquire、finally release（技术设计 §8 子任务往返）。mock 掉避免真
// spawn caffeinate，用 spy 断言每任务恰好 acquire/release 各一次（双扣防护由模块级 clamp 兜底）。
const keepAwakeSpy = vi.hoisted(() => ({ acquire: vi.fn(), release: vi.fn() }));
vi.mock('../../electron/main/keepAwake', () => ({
  acquire: keepAwakeSpy.acquire,
  release: keepAwakeSpy.release,
  setEnabled: vi.fn(),
  disposeKeepAwake: vi.fn(),
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

// ─── 延迟导入（等 vi.mock 提升后再加载） ───────────────────────────────────────

import { runTask } from '../../electron/main/tasks/subagentRunner';
import { getAgent } from '../../electron/main/agent/store/agents';
import { getBackendFor } from '../../electron/main/agent/backends';
import { createTask, updateTaskStatus } from '../../electron/main/tasks/store';
import { recordBaseline, computeAffectedPaths, recordEndTag } from '../../electron/main/tasks/git';
import { ensureFeatureBranch } from '../../electron/main/git/workflow';
import { getProject } from '../../electron/main/projects/store';
import { appendMessage as appendConvMessage } from '../../electron/main/conversations/store';
import { provisionAgent } from '../../electron/main/agent/capabilities';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

/** 构造非 anthropic stub backend（backendType != 'claude-code'，isReady ok:true） */
function makeNonAnthropicStub(): AgentBackend {
  return {
    backendType: 'openai-compatible',
    toolProtocol: 'native',
    isReady: vi.fn<AgentBackend['isReady']>().mockResolvedValue({ ok: true }),
    runConversation: vi.fn(),
    runOneShot: vi.fn(),
    registerTool: vi.fn(),
    unregisterTool: vi.fn(),
  } satisfies AgentBackend;
}

function makeBaseProposal(override: Partial<CodeActionProposal> = {}): CodeActionProposal {
  return {
    id: 'prop-1',
    kind: 'code',
    conversationId: 'conv-1',
    title: '测试提案',
    description: '测试',
    risk: 'low',
    rollbackable: true,
    rawPlan: '执行测试任务',
    targetProjectId: 'proj-1',
    status: 'pending',
    profileId: 'project-coder',
    deckContext: null,
    ...override,
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

function makeEmit(): (ev: ServerEventPayload) => void {
  return vi.fn();
}

// ─── 测试 ─────────────────────────────────────────────────────────────────────

describe('runTask 后端可用性', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // 默认桩：基本调用不崩
    vi.mocked(getAgent).mockResolvedValue(makeAgent());
    vi.mocked(createTask).mockResolvedValue(undefined);
    vi.mocked(updateTaskStatus).mockResolvedValue(undefined);
    vi.mocked(appendConvMessage).mockResolvedValue(undefined);

    // git 相关默认桩
    vi.mocked(recordBaseline).mockResolvedValue({ kind: 'commit', commit: 'abc123', tag: null, preExistingPaths: [] });
    vi.mocked(ensureFeatureBranch).mockResolvedValue('oru/test-branch');
    vi.mocked(computeAffectedPaths).mockResolvedValue({ affectedPaths: [], mixedDirtyPaths: [] });
    vi.mocked(recordEndTag).mockResolvedValue('oru/end-task-1');
    vi.mocked(getProject).mockResolvedValue({ id: 'proj-1', name: '测试项目', path: '/tmp/proj', ownerId: 'test-owner' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('非 anthropic backend + 配好 key → 正常走到 git 操作', async () => {
    const nonAnthropicBackend = makeNonAnthropicStub();
    vi.mocked(getBackendFor).mockResolvedValue(nonAnthropicBackend);

    // provisionAgent 之后抛错，让任务走到 catch 但 git 操作已经完成
    vi.mocked(provisionAgent).mockRejectedValue(new Error('test-stop-after-git-ops'));

    const emit = makeEmit();
    const proposal = makeBaseProposal({ profileId: 'project-coder' });

    await runTask({ agentId: 'agent-1', proposal, emit });

    // git 操作必须被调用（守卫未拦截）
    expect(getProject).toHaveBeenCalledWith('proj-1');
    expect(recordBaseline).toHaveBeenCalledWith('/tmp/proj', expect.any(String));
    expect(ensureFeatureBranch).toHaveBeenCalledWith('/tmp/proj', expect.any(String));

    // 回归：转 running 必须广播，否则渲染层停在 pending 快照、卡片徽标一路「准备中」
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'task.statusChanged', status: 'running' }),
    );

    // 任务因 provisionAgent 失败而 failed——这是预期内行为（守卫没触发，失败是后续）
    expect(updateTaskStatus).toHaveBeenCalledWith(
      expect.any(String),
      'failed',
      expect.objectContaining({ errorMessage: expect.stringContaining('test-stop-after-git-ops') }),
    );
  });

  it('keepAwake 挂钩（技术设计 §8）：每任务恰好 acquire / release 各一次（往返计数正确）', async () => {
    const nonAnthropicBackend = makeNonAnthropicStub();
    vi.mocked(getBackendFor).mockResolvedValue(nonAnthropicBackend);
    vi.mocked(provisionAgent).mockRejectedValue(new Error('test-stop'));

    keepAwakeSpy.acquire.mockClear();
    keepAwakeSpy.release.mockClear();

    await runTask({
      agentId: 'agent-1',
      proposal: makeBaseProposal({ profileId: 'project-coder' }),
      emit: makeEmit(),
    });

    // 任务 start/end 各一次，严格成对——多（散点双扣）或少（漏挂）都会在这里红
    expect(keepAwakeSpy.acquire).toHaveBeenCalledTimes(1);
    expect(keepAwakeSpy.release).toHaveBeenCalledTimes(1);
  });
});
