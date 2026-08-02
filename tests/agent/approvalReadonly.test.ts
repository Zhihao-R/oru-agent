/**
 * 只读挡硬约束回归（只读重构 PRD 决策二/三 + 技术设计 §7）。
 *
 * 验四件承重事：
 *  1. readonly 写类直接拒、不执行（文件写恒拒；bash 按 isReadOnly：写命令拒、只读命令放行；
 *     带 delivery 的 bash 外发同拒）。
 *  2. 挡位实时读 getAgent（决策三）——ctx.approvalMode 快照与实际挡位冲突时以实际挡位为准。
 *  3. 写类异步工具（mcp_install）在 readonly 下 execute 入口提前拒、不调 onProposal（防回执与卡片割裂）。
 *  4. readonlyPolicy:'allow'（2026-07-31 PM 拍板：只读可搜索可看网页）只读挡直执行、不拒不弹卡。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Agent,
  ActionProposal,
  FileWriteProposal,
  BashProposal,
  WebFetchProposal,
  DeckCreateProposal,
} from '@shared/types';
import type { ToolContext, ToolResult } from '@shared/agent/backend';

// 可变挡位：mock 的 getAgent 据此返回，模拟用户中途切挡（实时生效验证）。
const state = vi.hoisted(() => ({ mode: 'work' as Agent['approvalMode'] }));
// 只读拒绝理由按 owner 语言取词；固定中文以验「只读」字样（避开 electron app）。
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
  // realtimeApprovalModeFor 已下沉到 store/agents——同 module 内的真实调用看的是模块绑定，故 mock 也得给它，
  // 让它走 mock 的 getAgent（保留 fallback 语义），否则 approvalGate 调到 undefined。
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

import { proposeOrExecute } from '../../electron/main/agent/agentTools/emitProposal';
import { executeAgentTool, realtimeApprovalMode } from '../../electron/main/agent/agentTools/approvalGate';
import { makeMcpInstallTool } from '../../electron/main/agent/agentTools/mcp';
import { settleProposalDecision } from '../../electron/main/proposals/pendingDecision';
import { makeToolContext } from '../helpers/toolContext';

const makeCtx = (overrides?: Partial<ToolContext>): ToolContext =>
  makeToolContext({ conversationId: 'conv_1', agentId: 'twin', ownerId: 'local-user', ...overrides });

function fileWriteProposal(): FileWriteProposal {
  return {
    id: 'fw_1',
    ownerId: 'local-user',
    conversationId: 'conv_1',
    title: '写文件',
    description: 'x',
    createdAt: 1,
    status: 'pending',
    kind: 'file.write',
    op: 'write',
    path: '/tmp/x.txt',
    preview: 'hi',
  } as FileWriteProposal;
}

function bashProposal(isReadOnly: boolean): BashProposal {
  return {
    id: `bash_${isReadOnly ? 'ro' : 'rw'}`,
    ownerId: 'local-user',
    conversationId: 'conv_1',
    title: '跑命令',
    description: 'x',
    createdAt: 1,
    status: 'pending',
    kind: 'bash',
    command: isReadOnly ? 'ls' : 'rm x',
    isDestructive: !isReadOnly,
    isReadOnly,
    segments: [{ text: 'cmd', destructive: !isReadOnly }],
  } satisfies BashProposal;
}

beforeEach(() => {
  state.mode = 'work';
});

describe('readonly 硬约束', () => {
  it('文件写在 readonly 下直接拒、不执行', async () => {
    state.mode = 'readonly';
    let executed = false;
    const r = await proposeOrExecute(makeCtx(), fileWriteProposal(), {
      approvalText: 'x',
      execute: async (): Promise<ToolResult> => {
        executed = true;
        return { text: 'ran' };
      },
    });
    expect(executed).toBe(false);
    expect(r.text).toContain('只读');
  });

  it('bash 写命令在 readonly 下直接拒；只读命令放行执行', async () => {
    state.mode = 'readonly';
    let ranWrite = false;
    const rw = await proposeOrExecute(makeCtx(), bashProposal(false), {
      approvalText: 'x',
      execute: async (): Promise<ToolResult> => {
        ranWrite = true;
        return { text: 'ran' };
      },
    });
    expect(ranWrite).toBe(false);
    expect(rw.text).toContain('只读');

    let ranRead = false;
    const ro = await proposeOrExecute(makeCtx(), bashProposal(true), {
      approvalText: 'x',
      execute: async (): Promise<ToolResult> => {
        ranRead = true;
        return { text: 'ls-output' };
      },
    });
    expect(ranRead).toBe(true);
    expect(ro.text).toBe('ls-output');
  });

  it('挡位实时读：ctx 快照=work 但实际已切 readonly → 写仍被拒（决策三）', async () => {
    state.mode = 'readonly'; // 用户中途切只读
    let executed = false;
    const r = await proposeOrExecute(
      makeCtx({ approvalMode: 'work' }), // 快照仍是 work
      fileWriteProposal(),
      {
        approvalText: 'x',
        execute: async (): Promise<ToolResult> => {
          executed = true;
          return { text: 'ran' };
        },
      },
    );
    expect(executed).toBe(false);
    expect(r.text).toContain('只读');
  });

  // 2026-07-31 PM 拍板：只读 = 可搜索可看网页、不可改系统文件——web_fetch / browser_navigate
  // 传 readonlyPolicy:'allow'，只读挡不拒不弹卡、直执行（虽带 delivery 标记也不走投递硬拒）。
  it("web 读取（readonlyPolicy:'allow'）在 readonly 下直执行，带 delivery 也不拒", async () => {
    state.mode = 'readonly';
    let executed = false;
    const proposal = {
      id: 'web_1',
      ownerId: 'local-user',
      conversationId: 'conv_1',
      title: '抓取外部网页',
      description: 'https://example.com',
      createdAt: 1,
      status: 'pending',
      kind: 'web.fetch',
      url: 'https://example.com',
      delivery: [{ channel: 'web', recipient: 'example.com', label: 'https://example.com' }],
      forceApproval: true,
      grantable: [{ kind: 'category', id: 'webAccess' }],
    } satisfies WebFetchProposal;
    const r = await proposeOrExecute(makeCtx(), proposal, {
      approvalText: 'x',
      readonlyPolicy: 'allow',
      execute: async (): Promise<ToolResult> => {
        executed = true;
        return { text: 'fetched' };
      },
    });
    expect(executed).toBe(true);
    expect(r.text).toBe('fetched');
  });

  it("其余对外投递（无 readonlyPolicy:'allow'）在 readonly 下仍硬拒", async () => {
    state.mode = 'readonly';
    let executed = false;
    const proposal = {
      ...bashProposal(false),
      delivery: [{ channel: 'web', recipient: 'example.com', label: 'https://example.com' }],
    } satisfies BashProposal;
    const r = await proposeOrExecute(makeCtx(), proposal, {
      approvalText: 'x',
      execute: async (): Promise<ToolResult> => {
        executed = true;
        return { text: 'sent' };
      },
    });
    expect(executed).toBe(false);
    expect(r.text).toContain('只读');
  });

  // 'ask' 的语义本体是「只读挡恒弹卡等用户亲自批」——deck.create 在 work 挡直执行是有意的、
  // 不置 forceApproval，曾因此漏成只读挡直执行（review 抓出的预置洞）。锁定：只读挡弹卡、
  // 批准才执行；work 挡对照直执行不弹卡。
  it("readonlyPolicy:'ask'（deck.create，无 forceApproval）readonly 下恒弹卡、批准才执行", async () => {
    const deckProposal: DeckCreateProposal = {
      id: 'deck_1',
      ownerId: 'local-user',
      conversationId: 'conv_1',
      title: '新建演示稿',
      description: 'x',
      createdAt: 1,
      status: 'pending',
      kind: 'deck.create',
      deckName: 'd',
      targetProjectId: null,
      deckSkillId: 's',
      brief: 'b',
      sizeHint: 's',
      narrative: 'n',
      autoGenerate: false,
    };
    state.mode = 'readonly';
    let executed = false;
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const pending = proposeOrExecute(makeCtx({ onProposal }), deckProposal, {
      approvalText: 'x',
      readonlyPolicy: 'ask',
      execute: async (): Promise<ToolResult> => {
        executed = true;
        return { text: 'built' };
      },
    });
    await vi.waitFor(() => expect(onProposal).toHaveBeenCalledOnce());
    expect(executed).toBe(false); // 卡未批之前绝不执行
    settleProposalDecision(deckProposal.id, 'approved');
    const r = await pending;
    expect(executed).toBe(true);
    expect(r.text).toBe('built');

    // 对照：work 挡同一直执行、不弹卡（既有行为不回归）
    state.mode = 'work';
    let executedWork = false;
    const onProposalWork = vi.fn(async (_p: ActionProposal) => {});
    const rWork = await proposeOrExecute(
      makeCtx({ onProposal: onProposalWork }),
      { ...deckProposal, id: 'deck_2' },
      {
        approvalText: 'x',
        readonlyPolicy: 'ask',
        execute: async (): Promise<ToolResult> => {
          executedWork = true;
          return { text: 'built' };
        },
      },
    );
    expect(executedWork).toBe(true);
    expect(onProposalWork).not.toHaveBeenCalled();
    expect(rWork.text).toBe('built');
  });
});

describe('realtimeApprovalMode 原语', () => {
  it('realtimeApprovalMode 读 getAgent 实际挡位、不读 ctx 快照', async () => {
    state.mode = 'danger';
    expect(await realtimeApprovalMode(makeCtx({ approvalMode: 'work' }))).toBe('danger');
  });
});

describe('写类异步工具经中央闸 readonly 提前拒（防回执与卡片割裂）', () => {
  it('mcp_install 在 readonly 下经 executeAgentTool 拒、execute 不被调、不调 onProposal', async () => {
    state.mode = 'readonly';
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const tool = makeMcpInstallTool();
    // 中央闸在 mutatesEnvironment=true + 只读下、触达 execute 之前直接拒：onProposal 自然不会被调。
    const r = await executeAgentTool(
      tool,
      { label: 'linear', command: 'npx', args: ['-y', '@linear/mcp'] },
      makeCtx({ onProposal }),
    );
    expect(onProposal).not.toHaveBeenCalled();
    expect(r.text).toContain('只读');
  });
});
