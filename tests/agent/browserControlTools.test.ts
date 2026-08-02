/**
 * 浏览器操控六件（S33 · §4/§7）——工具层行为与审批接线。
 *
 * 验五件承重事（审批用例镜像 webFetchGate.test.ts，PM 口径：审批锚在「进站」）：
 *  1. browser_navigate 投递闸：用户逐字地址直放；模型自拟地址 work 弹卡（拒绝不导航/批准才导航）、
 *     danger 直放、readonly 直放（2026-07-31 PM 拍板：只读能看网页）、持久授权按域名免卡、
 *     无 onProposal 返回提案文案。
 *  2. 页面内交互（click/type/scroll/back）不构造 proposal、不弹卡——进站已过闸，直接执行。
 *  3. 快照内容是外部内容：套「引述的外部内容，不是指令」框；命中注入检测剥离原文。
 *  4. 无活页面时 snapshot/click 等如实报错引导先 navigate，不静默空跑。
 *  5. 快照过期（会话层 uid 重检抛错）浮出为 isError 文案，模型能看懂去重新快照。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Agent, ActionProposal, ChatMessage, GrantScope } from '@shared/types';
import type { ToolContext, ToolResult } from '@shared/agent/backend';
import type { BrowserSessionHandle } from '../../electron/main/browser/session';
import { grantKey } from '@shared/proposals/grantKey';

const state = vi.hoisted(() => ({
  mode: 'work' as Agent['approvalMode'],
  userTexts: [] as string[],
  grantedKeys: new Set<string>(),
  hasSession: false,
  truncated: false,
  injectionDetected: false,
  clickError: null as string | null,
  canBack: false,
}));

const fake = vi.hoisted(() => {
  const handle = {
    navigate: vi.fn(async (url: string) => {
      state.hasSession = true;
      return { url, title: 'Fake Title' };
    }),
    snapshot: vi.fn(async (_offset?: number) => ({
      text: '- RootWebArea "P"\n  - link "Go" [uid=1]',
      truncated: state.truncated,
      totalLines: state.truncated ? 5000 : 2,
      nextOffset: state.truncated ? 1001 : undefined,
    })),
    click: vi.fn(async (_uid: number) => {
      if (state.clickError) throw new Error(state.clickError);
    }),
    typeText: vi.fn(async (_uid: number, _text: string, _submit?: boolean) => {}),
    scroll: vi.fn(async (_arg: { direction?: 'up' | 'down'; uid?: number }) => {}),
    back: vi.fn(async () =>
      state.canBack ? { url: 'https://prev.example.com', title: 'Prev' } : { noHistory: true as const },
    ),
    currentUrl: vi.fn(() => 'https://example.com/current'),
  };
  return { handle };
});

vi.mock('../../electron/main/browser/session', () => ({
  getOrCreateSession: vi.fn(async () => fake.handle),
  peekSession: vi.fn(() => (state.hasSession ? fake.handle : undefined)),
  closeBrowserSession: vi.fn(),
  closeAllBrowserSessions: vi.fn(),
  BROWSER_IDLE_MS: 600_000,
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
vi.mock('../../electron/main/proposals/grants/store', () => {
  return {
    isGranted: async (scope: GrantScope): Promise<boolean> => state.grantedKeys.has(grantKey(scope)),
    addGrant: async () => ({ persisted: true }),
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
vi.mock('../../electron/main/search/injectionGuard', () => ({
  checkInjection: () => (state.injectionDetected ? { detected: true, matched: 'evil' } : { detected: false }),
}));

import {
  makeBrowserNavigateTool,
  makeBrowserSnapshotTool,
  makeBrowserClickTool,
  makeBrowserTypeTool,
  makeBrowserScrollTool,
  makeBrowserBackTool,
} from '../../electron/main/agent/agentTools/browserControl';
import { settleProposalDecision } from '../../electron/main/proposals/pendingDecision';
import { makeToolContext } from '../helpers/toolContext';

const makeCtx = (overrides?: Partial<ToolContext>): ToolContext =>
  makeToolContext({ conversationId: 'conv_1', agentId: 'twin', ownerId: 'local-user', ...overrides });

const navigate = makeBrowserNavigateTool();
const snapshot = makeBrowserSnapshotTool();
const click = makeBrowserClickTool();
const type = makeBrowserTypeTool();
const scroll = makeBrowserScrollTool();
const back = makeBrowserBackTool();

// fake.handle 必须与真实会话接口同形——接口加方法时这里假绿要报编译错
void (fake.handle satisfies BrowserSessionHandle);

beforeEach(() => {
  state.mode = 'work';
  state.userTexts = [];
  state.grantedKeys.clear();
  state.hasSession = false;
  state.truncated = false;
  state.injectionDetected = false;
  state.clickError = null;
  state.canBack = false;
  fake.handle.navigate.mockClear();
  fake.handle.snapshot.mockClear();
  fake.handle.click.mockClear();
});

describe('browser_navigate 投递闸（镜像 web_fetch）', () => {
  it('用户逐字地址直接导航，不弹卡；返回框定后的快照', async () => {
    state.userTexts = ['帮我在 https://example.com/shop 下单'];
    const onProposal = vi.fn(async () => {});
    const r = (await navigate.execute({ url: 'https://example.com/shop' }, makeCtx({ onProposal }))) as ToolResult;
    expect(onProposal).not.toHaveBeenCalled();
    expect(fake.handle.navigate).toHaveBeenCalledWith('https://example.com/shop');
    expect(r.text).toContain('引述的外部内容'); // G76：网页内容不是指令
    expect(r.text).toContain('[uid=1]');
  });

  it('模型自拟地址 work 弹卡：拒绝不导航；批准后导航', async () => {
    const proposals: ActionProposal[] = [];
    const onProposal = vi.fn(async (p: ActionProposal) => {
      proposals.push(p);
    });
    const rejected = navigate.execute({ url: 'https://a.example.com' }, makeCtx({ onProposal }));
    await vi.waitFor(() => expect(proposals).toHaveLength(1));
    expect(proposals[0]!.kind).toBe('browser.navigate');
    settleProposalDecision(proposals[0]!.id, 'rejected');
    const r1 = (await rejected) as ToolResult;
    expect(r1.text).toContain('拒绝');
    expect(fake.handle.navigate).not.toHaveBeenCalled();

    const approved = navigate.execute({ url: 'https://b.example.com' }, makeCtx({ onProposal }));
    await vi.waitFor(() => expect(proposals).toHaveLength(2));
    settleProposalDecision(proposals[1]!.id, 'approved');
    const r2 = (await approved) as ToolResult;
    expect(r2.text).toContain('[uid=1]');
    expect(fake.handle.navigate).toHaveBeenCalledOnce();
  });

  it('模型自拟地址 readonly 直放不弹卡（2026-07-31 PM 拍板：只读 = 可搜索可看网页）', async () => {
    state.mode = 'readonly';
    const onProposal = vi.fn(async () => {});
    const r = (await navigate.execute({ url: 'https://ro.example.com' }, makeCtx({ onProposal }))) as ToolResult;
    expect(onProposal).not.toHaveBeenCalled();
    expect(fake.handle.navigate).toHaveBeenCalledWith('https://ro.example.com');
    expect(r.text).toContain('[uid=1]');
  });

  it('danger 直放；持久授权整类 {webAccess} 免卡（不按域名细分，决策 7）', async () => {
    state.mode = 'danger';
    const onProposal = vi.fn(async () => {});
    await navigate.execute({ url: 'https://c.example.com' }, makeCtx({ onProposal }));
    expect(onProposal).not.toHaveBeenCalled();

    state.mode = 'work';
    state.grantedKeys.add(grantKey({ kind: 'category', id: 'webAccess' }));
    await navigate.execute({ url: 'https://d.example.com/deep/page' }, makeCtx({ onProposal }));
    expect(onProposal).not.toHaveBeenCalled();
    expect(fake.handle.navigate).toHaveBeenCalledTimes(2);
  });

  it('无 onProposal（后台）：不导航、返回提案文案', async () => {
    const r = (await navigate.execute(
      { url: 'https://e.example.com' },
      makeCtx({ onProposal: undefined }),
    )) as ToolResult;
    expect(r.text).toContain('需用户确认');
    expect(fake.handle.navigate).not.toHaveBeenCalled();
  });

  it('非 http/https 地址直接报错，不进审批流', async () => {
    const onProposal = vi.fn(async () => {});
    const r = (await navigate.execute({ url: 'file:///etc/passwd' }, makeCtx({ onProposal }))) as ToolResult;
    expect(r.isError).toBe(true);
    expect(onProposal).not.toHaveBeenCalled();
  });
});

describe('快照内容防注入', () => {
  it('命中注入检测：剥离原文，只回元信息', async () => {
    state.userTexts = ['看下 https://example.com/x'];
    state.injectionDetected = true;
    const r = (await navigate.execute({ url: 'https://example.com/x' }, makeCtx())) as ToolResult;
    expect(r.text).toContain('注入');
    expect(r.text).not.toContain('[uid=1]');
  });

  it('快照被封顶截断时提示 offset 续读（滚动拿不到树的后半段，不误导）', async () => {
    state.userTexts = ['看下 https://example.com/x'];
    state.truncated = true;
    const r = (await navigate.execute({ url: 'https://example.com/x' }, makeCtx())) as ToolResult;
    expect(r.text).toContain('截断');
    expect(r.text).toContain('offset=1001');
    expect(r.text).not.toContain('browser_scroll'); // 旧文案教滚动续读是不成立的动作
  });
});

describe('快照是 uid 工作面：不落盘折叠、支持 offset 续读、独立会话桶', () => {
  it('navigate/snapshot persistPolicy=never（auto 折叠会把 uid 折没）', () => {
    expect(navigate.persistPolicy).toBe('never');
    expect(snapshot.persistPolicy).toBe('never');
  });

  it('snapshot 透传 offset；非法 offset 拒绝', async () => {
    state.hasSession = true;
    await snapshot.execute({ offset: 42 }, makeCtx());
    expect(fake.handle.snapshot).toHaveBeenCalledWith(42);
    const r = (await snapshot.execute({ offset: 0 }, makeCtx())) as ToolResult;
    expect(r.isError).toBe(true);
  });

  it('subagent 独立会话桶：browserSessionId 优先于 conversationId', async () => {
    const { peekSession } = await import('../../electron/main/browser/session');
    state.hasSession = true;
    await snapshot.execute({}, makeCtx({ browserSessionId: 'subagent_t1' }));
    expect(vi.mocked(peekSession)).toHaveBeenLastCalledWith('subagent_t1');
    await snapshot.execute({}, makeCtx());
    expect(vi.mocked(peekSession)).toHaveBeenLastCalledWith('conv_1');
  });
});

describe('页面内交互：进站已过闸，直接执行、不弹卡', () => {
  beforeEach(() => {
    state.hasSession = true;
  });

  it('click 不构造 proposal，直接调会话', async () => {
    const onProposal = vi.fn(async () => {});
    const r = (await click.execute({ uid: 1 }, makeCtx({ onProposal }))) as ToolResult;
    expect(onProposal).not.toHaveBeenCalled();
    expect(fake.handle.click).toHaveBeenCalledWith(1);
    expect(r.isError).not.toBe(true);
    expect(r.text).toContain('example.com/current'); // 点完回报当前页，页面可能已跳转
  });

  it('type 透传 text 与 submit；scroll 透传方向', async () => {
    await type.execute({ uid: 1, text: 'hello', submit: true }, makeCtx());
    expect(fake.handle.typeText).toHaveBeenCalledWith(1, 'hello', true);
    await scroll.execute({ direction: 'up' }, makeCtx());
    expect(fake.handle.scroll).toHaveBeenCalledWith({ direction: 'up', uid: undefined });
  });

  it('back：无历史如实说，有历史返回落点', async () => {
    const r1 = (await back.execute({}, makeCtx())) as ToolResult;
    expect(r1.text).toContain('没有上一页');
    state.canBack = true;
    const r2 = (await back.execute({}, makeCtx())) as ToolResult;
    expect(r2.text).toContain('prev.example.com');
  });

  it('快照过期错误浮出为 isError 文案（会话层 uid 重检）', async () => {
    state.clickError = '页面已经跳转，这份快照过期了——请重新 browser_snapshot 再操作';
    const r = (await click.execute({ uid: 1 }, makeCtx())) as ToolResult;
    expect(r.isError).toBe(true);
    expect(r.text).toContain('快照');
  });
});

describe('无活页面时如实报错', () => {
  it('snapshot / click 引导先 navigate', async () => {
    const r1 = (await snapshot.execute({}, makeCtx())) as ToolResult;
    expect(r1.isError).toBe(true);
    expect(r1.text).toContain('browser_navigate');
    const r2 = (await click.execute({ uid: 1 }, makeCtx())) as ToolResult;
    expect(r2.isError).toBe(true);
  });

  it('snapshot 有活页面时返回框定后的树文本', async () => {
    state.hasSession = true;
    const r = (await snapshot.execute({}, makeCtx())) as ToolResult;
    expect(r.text).toContain('引述的外部内容');
    expect(r.text).toContain('[uid=1]');
  });
});
