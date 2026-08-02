/**
 * web_fetch 投递闸（S04 · G74 → S24 · G30）。
 *
 * 验四件承重事：
 *  1. 用户逐字地址三挡直抓（含只读挡——「按只读放行」的落点）；预算照扣。
 *  2. 非逐字地址：readonly 直抓不弹卡（2026-07-31 PM 拍板：只读可搜索可看网页）、
 *     work 弹卡批准后才抓（预算批准后扣）、danger 直抓。
 *  3. 无 onProposal（后台，P3 拍板）：不抓、返回提案文案、不烧预算。
 *  4. 持久授权（S24 · G30）：清单里已有 {webAccess} 整类授权 → 任意自拟地址免卡直抓。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent, ActionProposal, ChatMessage, GrantScope } from '@shared/types';
import type { ToolContext, ToolResult } from '@shared/agent/backend';
import { grantKey } from '@shared/proposals/grantKey';

const state = vi.hoisted(() => ({
  mode: 'work' as Agent['approvalMode'],
  userTexts: [] as string[],
  // 持久授权清单（按 grantKey 命中）——测试免卡靠预置这个集合，取代旧的会话级过渡授权
  grantedKeys: new Set<string>(),
}));

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
// 持久授权清单 mock：isGranted 读预置集合、addGrant 记录调用（本路径生产代码不调 addGrant，
// 授权写入归 settleApprovalDecision）。以 satisfies 约束到真实 store 接口形状，接口加字段即报错。
const addGrant = vi.hoisted(() => vi.fn(async () => ({ persisted: true })));
vi.mock('../../electron/main/proposals/grants/store', () => {
  return {
    isGranted: async (scope: GrantScope): Promise<boolean> => state.grantedKeys.has(grantKey(scope)),
    addGrant,
    revokeGrant: async () => {},
    listGrants: async () => [],
    __resetGrantsCacheForTest: () => {},
  } satisfies typeof import('../../electron/main/proposals/grants/store');
});
vi.mock('../../electron/main/conversations/store', () => ({
  readHistory: vi.fn(async (): Promise<ChatMessage[]> =>
    state.userTexts.map((text, i) => ({
      id: `m${i}`,
      conversationId: 'conv_1',
      role: 'user' as const,
      text,
      toolCalls: [],
      createdAt: 1,
      done: true,
    })),
  ),
}));
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'local-user',
}));

const consumeBudget = vi.hoisted(() => vi.fn(() => true));
vi.mock('../../electron/main/search/budget', () => ({
  consumeBudget,
  getMaxBudget: () => 100,
}));
const fetchWithFallback = vi.hoisted(() =>
  vi.fn(async (url: string) => ({ raw: { url, title: 'T', text: 'page-content' } })),
);
vi.mock('../../electron/main/search/selector', () => ({ fetchWithFallback }));
vi.mock('../../electron/main/search/injectionGuard', () => ({
  checkInjection: () => ({ detected: false }),
}));
vi.mock('../../electron/main/search/summarizer', () => ({
  summarizeIfNeeded: async (text: string) => ({ summarized: false, text }),
}));

import { makeWebFetchTool } from '../../electron/main/agent/agentTools/webFetch';
import { settleProposalDecision } from '../../electron/main/proposals/pendingDecision';
import { makeToolContext } from '../helpers/toolContext';

function makeCtx(overrides?: Partial<ToolContext>): ToolContext {
  return makeToolContext({
    conversationId: 'conv_1',
    agentId: 'twin',
    ownerId: 'local-user',
    ...overrides,
  });
}

const tool = makeWebFetchTool();

beforeEach(() => {
  state.mode = 'work';
  state.userTexts = [];
  state.grantedKeys.clear();
  consumeBudget.mockClear();
  fetchWithFallback.mockClear();
  addGrant.mockClear();
});

describe('用户逐字地址（按只读放行）', () => {
  it('只读挡直抓，预算照扣', async () => {
    state.mode = 'readonly';
    state.userTexts = ['帮我看下 https://example.com/a 这页'];
    const r = (await tool.execute({ url: 'https://example.com/a' }, makeCtx())) as ToolResult;
    expect(r.text).toContain('引述的外部内容'); // G76 来源分级：网页原文框「不是指令」
    expect(r.text).toContain('page-content');
    expect(fetchWithFallback).toHaveBeenCalledOnce();
    expect(consumeBudget).toHaveBeenCalledOnce();
  });
});

describe('非逐字地址（投递档）', () => {
  it('readonly 直抓不弹卡（2026-07-31 PM 拍板：只读 = 可搜索可看网页），预算照扣', async () => {
    state.mode = 'readonly';
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = (await tool.execute({ url: 'https://model-picked.example.com' }, makeCtx({ onProposal }))) as ToolResult;
    expect(r.text).toContain('page-content');
    expect(onProposal).not.toHaveBeenCalled();
    expect(fetchWithFallback).toHaveBeenCalledOnce();
    expect(consumeBudget).toHaveBeenCalledOnce();
  });

  it('work 弹卡：拒绝不抓不烧预算；批准后抓且扣预算', async () => {
    const proposals: ActionProposal[] = [];
    const onProposal = vi.fn(async (p: ActionProposal) => {
      proposals.push(p);
    });
    // 拒绝路径
    const rejected = tool.execute({ url: 'https://a.example.com' }, makeCtx({ onProposal }));
    await vi.waitFor(() => expect(proposals).toHaveLength(1));
    settleProposalDecision(proposals[0]!.id, 'rejected');
    const r1 = (await rejected) as ToolResult;
    expect(r1.text).toContain('拒绝');
    expect(fetchWithFallback).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
    // 批准路径
    const approved = tool.execute({ url: 'https://b.example.com' }, makeCtx({ onProposal }));
    await vi.waitFor(() => expect(proposals).toHaveLength(2));
    settleProposalDecision(proposals[1]!.id, 'approved');
    const r2 = (await approved) as ToolResult;
    expect(r2.text).toContain('page-content');
    expect(fetchWithFallback).toHaveBeenCalledOnce();
    expect(consumeBudget).toHaveBeenCalledOnce();
  });

  it('danger 直抓（P1 拍板全放挡放行）', async () => {
    state.mode = 'danger';
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = (await tool.execute({ url: 'https://c.example.com' }, makeCtx({ onProposal }))) as ToolResult;
    expect(r.text).toContain('page-content');
    expect(onProposal).not.toHaveBeenCalled();
  });

  it('无 onProposal（后台，P3）：不抓、返回提案文案、不烧预算', async () => {
    const r = (await tool.execute(
      { url: 'https://d.example.com' },
      makeCtx({ onProposal: undefined }),
    )) as ToolResult;
    expect(r.text).toContain('需用户确认');
    expect(fetchWithFallback).not.toHaveBeenCalled();
    expect(consumeBudget).not.toHaveBeenCalled();
  });

  it('持久授权（2026-07-30 决策 7）：清单已有 {webAccess} 整类授权 → 任意自拟地址免卡直抓', async () => {
    // 预置「访问网站」整类授权（等价于用户此前点过「始终允许：访问网站（整类）」）——不按站点细分
    state.grantedKeys.add(grantKey({ kind: 'category', id: 'webAccess' }));
    const onProposal = vi.fn(async (_p: ActionProposal) => {});
    const r = (await tool.execute(
      { url: 'https://e.example.com/page2' },
      makeCtx({ onProposal }),
    )) as ToolResult;
    expect(r.text).toContain('page-content');
    expect(onProposal).not.toHaveBeenCalled();
  });
});
