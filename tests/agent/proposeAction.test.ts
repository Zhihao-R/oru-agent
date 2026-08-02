/**
 * Task(mode='async') 派工守卫回归（委派工具收敛 2026-08-02，承接原 propose_action D7 早失败 UX）
 *
 * dispatchAsyncSubagent 是 Task 工具 async 分支的共享派发函数，验三条不变量：
 * 1. !ready.ok → isError 透出 hint，不含硬编码文案
 * 2. ready ok → 不被拒绝，继续流程；目标项目 / 风险 / 回滚等元数据由系统默认填充
 * 3. onProposal 抛错 → isError 如实报「派发失败」
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ActionProposal, CodeActionProposal } from '@shared/types';
import type { ProposeBuildResult } from '../../electron/main/agent/oruMcpFactory';
import { makeToolContext } from '../helpers/toolContext';
import { dispatchAsyncSubagent } from '../../electron/main/agent/agentTools/dispatchAsyncSubagent';

// ─── mock 声明 ────────────────────────────────────────────────────────────────

vi.mock('../../electron/main/agent/backends', () => ({
  subagentCoderReady: vi.fn<() => Promise<{ ok: boolean; hint?: string }>>(),
}));

vi.mock('../../electron/main/agent/oruMcpFactory', () => ({
  buildProposalFromInput: vi.fn<() => Promise<ProposeBuildResult>>(),
}));

vi.mock('../../electron/main/projects/store', () => ({
  getProject: vi.fn(),
}));

vi.mock('../../electron/main/projects/gitHint', () => ({
  maybeShowGitHint: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

// ─── 延迟导入 ──────────────────────────────────────────────────────────────────

import { subagentCoderReady } from '../../electron/main/agent/backends';
import { buildProposalFromInput } from '../../electron/main/agent/oruMcpFactory';

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function makeToolCtx(overrides?: Parameters<typeof makeToolContext>[0]) {
  return makeToolContext({ conversationId: 'conv-1', agentId: 'agent-1', ownerId: 'test-owner', ...overrides });
}

/** buildProposalFromInput 成功返回的 fixture——satisfies 真实类型，接口加字段时假绿会被编译挡住。 */
function okBuildResult(proposalId: string): ProposeBuildResult {
  const proposal: CodeActionProposal = {
    id: proposalId,
    kind: 'code',
    conversationId: 'conv-1',
    title: '测试任务',
    description: '测试说明',
    risk: 'medium',
    rollbackable: true,
    rawPlan: '执行测试',
    targetProjectId: 'prj-1',
    status: 'pending',
    profileId: 'project-coder',
    deckContext: null,
  };
  return { ok: true, toolText: '提案已提交', proposal };
}

// ─── 测试 ─────────────────────────────────────────────────────────────────────

describe('Task(mode=async) 派工守卫（沿 D7）', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('!ready.ok → isError 透出 hint，不含硬编码「配置 Claude」', async () => {
    vi.mocked(subagentCoderReady).mockResolvedValue({
      ok: false,
      hint: '缺少 OpenRouter API Key，请在设置中填入',
    });

    const r = await dispatchAsyncSubagent(makeToolCtx(), { description: '测试任务', prompt: '执行测试' });

    expect(r.isError).toBe(true);
    expect(r.text).toContain('缺少 OpenRouter API Key');
    expect(r.text).not.toContain('配置 Claude');
    expect(buildProposalFromInput).not.toHaveBeenCalled();
  });

  it('ready ok → 不被拒绝，继续流程；targetProjectId 取 ctx.activeProjectId（非 null）', async () => {
    vi.mocked(subagentCoderReady).mockResolvedValue({ ok: true });
    vi.mocked(buildProposalFromInput).mockResolvedValue(okBuildResult('p-2'));

    const r = await dispatchAsyncSubagent(
      makeToolCtx({ activeProjectId: 'prj-active' }),
      { description: '测试任务', prompt: '执行测试' },
    );

    expect(buildProposalFromInput).toHaveBeenCalledWith(
      expect.objectContaining({
        targetProjectId: 'prj-active', // 承重前提：必须填 ctx.activeProjectId，不能漏成 null
        risk: 'medium', // 模型不填审批元数据，系统默认填充
        rollbackable: true, // 占位 true：实际值由 buildProposalFromInput 按 git 判（git→true / 非 git→false）
        title: '测试任务',
        description: '测试任务',
        rawPlan: '执行测试',
      }),
    );
    expect(r.isError).toBeFalsy();
  });

  it('ready ok + 无 active project → targetProjectId 回落 null（家目录任务）', async () => {
    vi.mocked(subagentCoderReady).mockResolvedValue({ ok: true });
    const buildSpy = vi.mocked(buildProposalFromInput).mockResolvedValue(okBuildResult('p-6'));

    await dispatchAsyncSubagent(makeToolCtx({ activeProjectId: undefined }), {
      description: '测试任务',
      prompt: '执行测试',
    });

    expect(buildSpy).toHaveBeenCalledWith(expect.objectContaining({ targetProjectId: null }));
  });

  // ── 派工回执如实（本次回归核心）──────────────────────────────────────────────
  // 派工（code）不过挡位、恒自动执行（shouldAutoExecuteProposal: kind==='code' 恒 true）。
  // onProposal 成功即已入队后台跑，回执必须如实说「已派工」，绝不能出现「等你批准/等确认」
  // 之类措辞——否则模型会照着让用户去点根本不存在的批准按钮（危险档下真实发生过）。

  const noApprovalWording = /等.*批准|点.*批准|等你批准|等待用户决策|审批模式|信任模式|等确认|待确认/;

  it('派工成功（danger 档 + onProposal）→ 回执明确「已派工」，不含审批措辞', async () => {
    vi.mocked(subagentCoderReady).mockResolvedValue({ ok: true });
    vi.mocked(buildProposalFromInput).mockResolvedValue(okBuildResult('p-3'));
    const onProposal = vi.fn<(p: ActionProposal) => Promise<void>>().mockResolvedValue(undefined);

    const r = await dispatchAsyncSubagent(
      makeToolCtx({ approvalMode: 'danger', onProposal, activeProjectId: 'prj-1' }),
      { description: '测试任务', prompt: '执行测试' },
    );

    expect(onProposal).toHaveBeenCalledOnce();
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/派工|派给后台|派给.*subagent/);
    expect(r.text).not.toMatch(noApprovalWording);
  });

  it('派工成功（work 档 + onProposal）→ 同样「已派工」不等审批（证明与挡位无关）', async () => {
    vi.mocked(subagentCoderReady).mockResolvedValue({ ok: true });
    vi.mocked(buildProposalFromInput).mockResolvedValue(okBuildResult('p-4'));
    const onProposal = vi.fn<(p: ActionProposal) => Promise<void>>().mockResolvedValue(undefined);

    const r = await dispatchAsyncSubagent(
      makeToolCtx({ approvalMode: 'work', onProposal, activeProjectId: 'prj-1' }),
      { description: '测试任务', prompt: '执行测试' },
    );

    expect(onProposal).toHaveBeenCalledOnce();
    expect(r.text).not.toMatch(noApprovalWording);
  });

  it('onProposal 抛错 → isError 如实报「派发失败」，不谎称已派工', async () => {
    vi.mocked(subagentCoderReady).mockResolvedValue({ ok: true });
    vi.mocked(buildProposalFromInput).mockResolvedValue(okBuildResult('p-5'));
    const onProposal = vi
      .fn<(p: ActionProposal) => Promise<void>>()
      .mockRejectedValue(new Error('入队失败'));

    const r = await dispatchAsyncSubagent(
      makeToolCtx({ approvalMode: 'danger', onProposal, activeProjectId: 'prj-1' }),
      { description: '测试任务', prompt: '执行测试' },
    );

    expect(r.isError).toBe(true);
    expect(r.text).toContain('派发失败');
    expect(r.text).not.toMatch(/派给后台|正在跑/);
  });
});
