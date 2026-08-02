/**
 * mcp 类提案「拒绝=不执行 / 至多执行一次」回归——2026-07-03 审计 Bug 1。
 *
 * 病灶：执行全程（可长达 5-30s）不迁 executing，status 停在 pending，
 * 期间用户点拒绝会被照单全收：环境已改、卡片却显示已拒绝。
 * 防线：执行开始即经 transitionProposal 迁 executing——此后 reject 被 handler 的
 * 非 pending 防抖挡住；「同时点确认+拒绝」并发场景拒绝先落地则执行零次。
 *
 * 经真实 handler（proposalTaskHandlers）驱动，与 route() 分发同一代码路径。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpDeleteProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { ErrorCodes } from '@shared/types';

// maybeResumeTurn 会经 listAgents → startNonUserMainTurn 打真实 store / LLM——测试中掐掉，
// 其余符号（getProposal / rememberProposal 等）保留真实实现（共享同一 proposals Map）。
vi.mock('../../electron/main/ws/handlers/resumeTurn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/ws/handlers/resumeTurn')>();
  return {
    ...actual,
    maybeResumeTurn: vi.fn(async () => {}) satisfies typeof actual.maybeResumeTurn,
  };
});

// 拒绝路径的系统记会 appendMessage 到真实用户目录——测试中掐掉
vi.mock('../../electron/main/proposals/systemEvent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/proposals/systemEvent')>();
  return {
    ...actual,
    writeRejectionSystemEvent: vi.fn(
      async () => {},
    ) satisfies typeof actual.writeRejectionSystemEvent,
  };
});

// perform 内 getSettings().catch(() => null)——抛错走 catch 回落默认语言，避免读真实 ~/.oru
vi.mock('../../electron/main/projects/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/projects/store')>();
  const getSettings = vi.fn(async () => {
    throw new Error('测试环境无 settings');
  }) satisfies typeof actual.getSettings;
  return { ...actual, getSettings };
});

// mcp registry：deleteServer 用可控闸门模拟 5-30s 的真实执行窗口。
// vi.mock 工厂会被提升到文件顶部——工厂里引用的变量必须经 vi.hoisted 同步提升。
const { deleteServerMock, releaseDelete } = vi.hoisted(() => {
  let release: () => void = () => {};
  const mock = vi.fn(async (_serverId: string): Promise<boolean> => {
    await new Promise<void>((r) => (release = r));
    return true;
  });
  return { deleteServerMock: mock, releaseDelete: () => release() };
});
vi.mock('../../electron/main/mcp/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/mcp/registry')>();
  return {
    ...actual,
    deleteServer: deleteServerMock satisfies typeof actual.deleteServer,
  };
});

import { proposalTaskHandlers } from '../../electron/main/ws/handlers/proposals';
import { rememberProposal } from '../../electron/main/proposals/registry';
import type { Reply } from '../../electron/main/ws/server';

let seq = 0;
function makeMcpDelete(): McpDeleteProposal {
  return {
    id: `prop_async_${seq++}`,
    ownerId: 'local-user',
    conversationId: 'conv_async',
    title: '删除 MCP server',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    kind: 'mcp.delete',
    serverId: 'srv_1',
    target: { label: 'test-server' },
  } satisfies McpDeleteProposal;
}

function harness() {
  const events: ServerEvent[] = [];
  const replies: Array<{ reqId: string; type: string; code?: string }> = [];
  const broadcast = (ev: ServerEvent) => {
    events.push(ev);
  };
  const reply: Reply = (reqId, ev) => {
    replies.push({ reqId, type: ev.type, code: (ev as { code?: string }).code });
  };
  const statuses = () =>
    events
      .filter((e) => e.type === 'proposal.statusChanged')
      .map((e) => (e as { status: string }).status);
  return { events, replies, broadcast, reply, statuses };
}

beforeEach(() => {
  deleteServerMock.mockClear();
});

describe('mcp 提案：执行窗口内拒绝不生效（Bug 1）', () => {
  it('execute 开始即迁 executing；执行中 reject 不生效；最终 executed 且恰好执行一次', async () => {
    const p = makeMcpDelete();
    rememberProposal(p);
    const h = harness();

    await proposalTaskHandlers['proposal.execute']!(
      { type: 'proposal.execute', reqId: 'r1', proposalId: p.id },
      { reply: h.reply, broadcast: h.broadcast },
    );
    // 独立执行器是 void 起跑，且按 kind 动态 import 领域模块——等到 perform 真被调用为止。
    // 别用固定 tick：await 层数会随重构变化，睡不够就误判成「没执行」。
    await vi.waitFor(() => expect(deleteServerMock).toHaveBeenCalledTimes(1));

    // 执行已开始（deleteServer 卡在闸门里）：状态必须已占住 executing
    expect(p.status).toBe('executing');

    // 执行中点拒绝：不得生效，且如实报错——不 ack 假装成功（与 code 分支同一哲学）
    await proposalTaskHandlers['proposal.reject']!(
      { type: 'proposal.reject', reqId: 'r2', proposalId: p.id },
      { reply: h.reply, broadcast: h.broadcast },
    );
    expect(p.status).toBe('executing');
    const rejectReply = h.replies.find((r) => r.reqId === 'r2');
    expect(rejectReply?.type).toBe('error');
    expect(rejectReply?.code).toBe(ErrorCodes.TASK_BUSY);

    releaseDelete();
    await vi.waitFor(() => expect(p.status).toBe('executed'));
    // 全程恰好执行一次，广播时序 executing → executed，中间没有 rejected
    expect(deleteServerMock).toHaveBeenCalledTimes(1);
    expect(h.statuses()).toEqual(['executing', 'executed']);
  });

  it('同时点确认+拒绝：先到先得，先处理者赢、至多执行一次（S24 决定收口）', async () => {
    // S24 收口后并发是「先到先得」（plan §5，卡片永远只有一个结局）：谁的决定先被处理谁生效，
    // 其余得 already-decided。此处 execute 先被调用 → 先认领 approve → 执行一次；reject 后到被挡。
    // 关键安全性质「至多执行一次」由认领门保证（不会既执行又拒绝、不会双执行）；
    // 旧「拒绝恒优先」是 S24 前的语义，已被先到先得取代（新 UI 下批准即换存证卡，无第二次点击面）。
    const p = makeMcpDelete();
    rememberProposal(p);
    const h = harness();

    const executing = proposalTaskHandlers['proposal.execute']!(
      { type: 'proposal.execute', reqId: 'r1', proposalId: p.id },
      { reply: h.reply, broadcast: h.broadcast },
    );
    const rejecting = proposalTaskHandlers['proposal.reject']!(
      { type: 'proposal.reject', reqId: 'r2', proposalId: p.id },
      { reply: h.reply, broadcast: h.broadcast },
    );
    await Promise.all([executing, rejecting]);
    // 独立执行器已迁 executing 并进 deleteServer 闸门后再释放（闸门的 release 在
    // deleteServer 被调用那一刻才就位）
    await vi.waitFor(() => expect(deleteServerMock).toHaveBeenCalled());
    releaseDelete();
    await vi.waitFor(() => expect(p.status).toBe('executed'));

    // 先到的 approve 赢：执行恰好一次、终态 executed；后到的 reject 被挡（ack，不叠加拒绝态）
    expect(deleteServerMock).toHaveBeenCalledTimes(1);
    expect(h.statuses()).toEqual(['executing', 'executed']);
    expect(h.replies.find((r) => r.reqId === 'r2')?.type).toBe('ack');
  });

  it('执行失败：executing → failed，failureMessage 落上', async () => {
    const p = makeMcpDelete();
    rememberProposal(p);
    const h = harness();
    deleteServerMock.mockImplementationOnce(async () => false); // server not found → throw

    await proposalTaskHandlers['proposal.execute']!(
      { type: 'proposal.execute', reqId: 'r1', proposalId: p.id },
      { reply: h.reply, broadcast: h.broadcast },
    );
    await vi.waitFor(() => expect(p.status).toBe('failed'));
    // 上屏文案按 owner 语言取词（已知失败），故只断言「落上了、指明是哪个 server」——
    // 不钉具体措辞，否则测试跟着界面语言走。
    expect(p.failureMessage).toBeTruthy();
    expect(p.failureMessage).toContain('srv_1');
    expect(h.statuses()).toEqual(['executing', 'failed']);
  });
});
