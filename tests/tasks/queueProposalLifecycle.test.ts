/**
 * code 提案「双击双跑 / 拒绝不撤任务」回归——2026-07-03 审计 Bug 2，去串行后语义（方案 review-rev 2）。
 *
 * 去串行（queue 立即起跑）后「排队中可撤」窗口消失：approve 即迁 executing，reject/discard 对已起跑
 * 任务无撤卡路径。防线改为：
 * - enqueue 起跑守卫：status 非 pending 不入队（拒绝=不执行）；
 * - 起跑即迁 executing（同步、无 await 间隙），「双击 execute / 信任模式叠加」的二次入队被非 pending 挡；
 * - 已起跑后 reject → proposals handler 判 executing 如实报 TASK_BUSY、不假装成功；
 * - discard 只删 proposals Map、无法拦已起跑任务（取舍，见 plan「已知限制/取舍」）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeActionProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { ErrorCodes } from '@shared/types';

// maybeResumeTurn / 系统记 / 终态播报都会打真实 store——测试中掐掉，其余符号保留真实实现
vi.mock('../../electron/main/ws/handlers/resumeTurn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/ws/handlers/resumeTurn')>();
  return {
    ...actual,
    maybeResumeTurn: vi.fn(async () => {}) satisfies typeof actual.maybeResumeTurn,
  };
});
vi.mock('../../electron/main/proposals/systemEvent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/proposals/systemEvent')>();
  return {
    ...actual,
    writeRejectionSystemEvent: vi.fn(
      async () => {},
    ) satisfies typeof actual.writeRejectionSystemEvent,
  };
});
vi.mock('../../electron/main/tasks/taskAnnouncer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/taskAnnouncer')>();
  return {
    ...actual,
    notifyTaskTerminal: vi.fn(() => {}) satisfies typeof actual.notifyTaskTerminal,
  };
});
// proposal.execute 的 code 分支要拿 activeId 派工——给个假 agent，避免读真实 ~/.oru
vi.mock('../../electron/main/agent/store/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/agent/store/agents')>();
  return {
    ...actual,
    listAgents: vi.fn(async () => ({
      agents: [],
      activeId: 'agent_test',
    })) satisfies typeof actual.listAgents,
  };
});

import { proposalTaskHandlers } from '../../electron/main/ws/handlers/proposals';
import { rememberProposal } from '../../electron/main/proposals/registry';
import { transitionProposal } from '../../electron/main/proposals/lifecycle';
import { enqueue, __setRunFnForTest } from '../../electron/main/tasks/queue';
import { __resetActiveTasksForTest } from '../../electron/main/tasks/subagentRunner';
import type { Reply } from '../../electron/main/ws/server';

let seq = 0;
function makeCodeProposal(targetProjectId: string): CodeActionProposal {
  return {
    id: `prop_code_${seq++}`,
    ownerId: 'local-user',
    conversationId: 'conv_code',
    title: '改代码',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    kind: 'code',
    targetProjectId,
    risk: 'low',
    rollbackable: true,
    rawPlan: '测试计划',
  } satisfies CodeActionProposal;
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
  return { events, replies, broadcast, reply };
}

/** 可控 runFn：每个任务卡在闸门里直到 release，记录跑过哪些 proposalId（不进 activeTasks） */
function gatedRunFn() {
  const started: string[] = [];
  const gates: Array<() => void> = [];
  const restore = __setRunFnForTest(async (item) => {
    started.push(item.proposal.id);
    await new Promise<void>((r) => gates.push(r));
  });
  return { started, releaseAll: () => gates.splice(0).forEach((r) => r()), restore };
}

const tick = () => new Promise((r) => setTimeout(r, 10));

const execute = (p: CodeActionProposal, h: ReturnType<typeof harness>, reqId: string) =>
  proposalTaskHandlers['proposal.execute']!(
    { type: 'proposal.execute', reqId, proposalId: p.id },
    { reply: h.reply, broadcast: h.broadcast },
  );
const reject = (p: CodeActionProposal, h: ReturnType<typeof harness>, reqId: string) =>
  proposalTaskHandlers['proposal.reject']!(
    { type: 'proposal.reject', reqId, proposalId: p.id },
    { reply: h.reply, broadcast: h.broadcast },
  );
const discard = (p: CodeActionProposal, h: ReturnType<typeof harness>, reqId: string) =>
  proposalTaskHandlers['proposal.discard']!(
    { type: 'proposal.discard', reqId, proposalId: p.id },
    { reply: h.reply, broadcast: h.broadcast },
  );

beforeEach(() => {
  __resetActiveTasksForTest();
});

describe('code 提案：去串行后的幂等 + 拒绝语义（Bug 2）', () => {
  it('连续两次 execute 同一提案：恰好一个任务、恰好跑一次', async () => {
    const p = makeCodeProposal('proj_dedup');
    rememberProposal(p);
    const h = harness();
    const run = gatedRunFn();
    try {
      await execute(p, h, 'r1');
      await execute(p, h, 'r2'); // 双击第二发——status 已 executing，settle 的 pending 守卫挡下
      await tick();
      run.releaseAll();
      await tick();

      expect(run.started).toEqual([p.id]); // 恰好跑一次
    } finally {
      run.restore();
    }
  });

  it('同一 pending 提案直接入队两次：status 守卫幂等（信任模式自动 + 手点叠加）', async () => {
    const p = makeCodeProposal('proj_stack');
    const h = harness();
    const run = gatedRunFn();
    try {
      enqueue({ agentId: 'agent_test', proposal: p, emit: h.broadcast }); // 起跑即迁 executing
      enqueue({ agentId: 'agent_test', proposal: p, emit: h.broadcast }); // 第二次被非 pending 挡
      run.releaseAll();
      await tick();
      expect(run.started).toEqual([p.id]);
    } finally {
      run.restore();
    }
  });

  it('已起跑后 reject：拒绝不生效且如实报错，任务跑完提案落 executed', async () => {
    const p = makeCodeProposal('proj_running');
    rememberProposal(p);
    const h = harness();
    const run = gatedRunFn();
    try {
      await execute(p, h, 'r1');
      expect(run.started).toEqual([p.id]);
      expect(p.status).toBe('executing'); // approve 即起跑、占住状态

      await reject(p, h, 'r2');
      expect(p.status).toBe('executing'); // 拒绝不生效
      const rejectReply = h.replies.find((r) => r.reqId === 'r2');
      expect(rejectReply?.type).toBe('error'); // 如实报错，不假装成功
      expect(rejectReply?.code).toBe(ErrorCodes.TASK_BUSY);

      run.releaseAll();
      await vi.waitFor(() => expect(p.status).toBe('executed'));
      expect(run.started).toEqual([p.id]); // 全程恰好跑一次
    } finally {
      run.restore();
    }
  });

  it('起跑守卫：入队前 status 已非 pending → 不执行（拒绝=不执行）', async () => {
    const p = makeCodeProposal('proj_guard');
    const h = harness();
    const run = gatedRunFn();
    try {
      // 不走 enqueue 的旁路（如 turn 中止撤卡）先置终态，再迟到 enqueue
      transitionProposal(p, 'rejected', h.broadcast);
      enqueue({ agentId: 'agent_test', proposal: p, emit: h.broadcast });

      run.releaseAll();
      await tick();
      expect(run.started).toEqual([]); // 拒绝=不执行
      expect(p.status).toBe('rejected'); // 终态未被扰动
    } finally {
      run.restore();
    }
  });

  it('discard 无法拦已起跑任务（去串行取舍）：任务照跑完成', async () => {
    const p = makeCodeProposal('proj_discard');
    rememberProposal(p);
    const h = harness();
    const run = gatedRunFn();
    try {
      await execute(p, h, 'r1');
      expect(run.started).toEqual([p.id]); // approve 即起跑

      await discard(p, h, 'r2'); // 只删 proposals Map，不 abort 已起跑任务
      expect(run.started).toEqual([p.id]); // 未新增派工

      run.releaseAll();
      await vi.waitFor(() => expect(p.status).toBe('executed')); // 已起跑任务照常跑完收终态
      expect(run.started).toEqual([p.id]);
    } finally {
      run.restore();
    }
  });
});
