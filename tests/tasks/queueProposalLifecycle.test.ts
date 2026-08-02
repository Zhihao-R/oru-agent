/**
 * code 提案「双击双跑 / 拒绝不撤任务」回归——2026-07-03 审计 Bug 2。
 *
 * 病灶三路：双击 execute 同一提案入队两次（两份 commit）；点执行后点拒绝任务照跑
 * （cancelInQueue 全仓零调用方）；信任模式自动 enqueue 与手点叠加。
 * 防线：queue.enqueue 按 proposalId/状态幂等去重；排队中保持 pending（可拒），
 * 起跑才迁 executing（executing → rejected 非法，起跑后拒绝无撤回路径）；
 * reject 对排队未起跑的任务调 cancelInQueue 撤下，对已起跑的如实报错不假装成功。
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
import {
  enqueue,
  getQueueDepth,
  __setRunFnForTest,
  __resetQueuesForTest,
} from '../../electron/main/tasks/queue';
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

/** 可控 runFn：每个任务卡在闸门里直到 release，记录跑过哪些 proposalId */
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
  __resetQueuesForTest();
});

describe('code 提案：入队去重 + 拒绝撤队（Bug 2）', () => {
  it('连续两次 execute 同一提案：恰好一个任务、恰好跑一次', async () => {
    const p = makeCodeProposal('proj_dedup');
    rememberProposal(p);
    const h = harness();
    const run = gatedRunFn();
    try {
      await execute(p, h, 'r1');
      await execute(p, h, 'r2'); // 双击第二发
      await tick();
      run.releaseAll();
      await tick();
      run.releaseAll(); // 若重复入队，第二个任务此刻会起跑
      await tick();

      expect(run.started).toEqual([p.id]); // 恰好跑一次
      expect(getQueueDepth()['proj_dedup']?.pendingCount ?? 0).toBe(0);
    } finally {
      run.restore();
    }
  });

  it('信任模式自动 enqueue 与手点叠加：同一提案直接二次入队也幂等', async () => {
    const blocker = makeCodeProposal('proj_stack');
    const p = makeCodeProposal('proj_stack');
    const h = harness();
    const run = gatedRunFn();
    try {
      enqueue({ agentId: 'agent_test', proposal: blocker, emit: h.broadcast }); // 占住队列
      enqueue({ agentId: 'agent_test', proposal: p, emit: h.broadcast }); // 排队（信任模式自动）
      enqueue({ agentId: 'agent_test', proposal: p, emit: h.broadcast }); // 手点叠加
      expect(getQueueDepth()['proj_stack']?.pendingCount).toBe(1); // 队列里恰好一份

      run.releaseAll();
      await tick();
      run.releaseAll();
      await tick();
      expect(run.started).toEqual([blocker.id, p.id]);
    } finally {
      run.restore();
    }
  });

  it('execute 后 reject（排队未起跑）：cancelInQueue 撤下、任务不跑、终态 rejected', async () => {
    const blocker = makeCodeProposal('proj_cancel');
    const p = makeCodeProposal('proj_cancel');
    rememberProposal(p);
    const h = harness();
    const run = gatedRunFn();
    try {
      enqueue({ agentId: 'agent_test', proposal: blocker, emit: h.broadcast }); // 占住队列
      await execute(p, h, 'r1'); // p 入队排队，尚未起跑
      expect(getQueueDepth()['proj_cancel']?.pendingCount).toBe(1);

      await reject(p, h, 'r2');
      expect(p.status).toBe('rejected');
      expect(getQueueDepth()['proj_cancel']?.pendingCount).toBe(0); // 已从队列撤下

      run.releaseAll(); // blocker 跑完，队列推进
      await tick();
      expect(run.started).toEqual([blocker.id]); // p 从未起跑
    } finally {
      run.restore();
    }
  });

  it('起跑守卫：排队期间被置非 pending（绕过 cancelInQueue 的拒绝路径）→ 不执行，队列照常推进', async () => {
    const blocker = makeCodeProposal('proj_guard');
    const p = makeCodeProposal('proj_guard');
    const after = makeCodeProposal('proj_guard');
    const h = harness();
    const run = gatedRunFn();
    try {
      enqueue({ agentId: 'agent_test', proposal: blocker, emit: h.broadcast }); // 占住队列
      enqueue({ agentId: 'agent_test', proposal: p, emit: h.broadcast }); // 排队
      enqueue({ agentId: 'agent_test', proposal: after, emit: h.broadcast }); // 排在 p 之后
      // 模拟不走 cancelInQueue 的拒绝路径（如 turn 中止撤卡）：状态已 rejected、item 仍在队列
      transitionProposal(p, 'rejected', h.broadcast);

      run.releaseAll(); // blocker 跑完 → 队列推进到 p（应跳过）→ after 起跑
      await tick();
      run.releaseAll(); // 若 p 被误跑，这里会放它过；正确行为是它从未 started
      await tick();

      expect(run.started).toEqual([blocker.id, after.id]); // 拒绝=不执行，且队列没卡死
      expect(p.status).toBe('rejected'); // 终态未被扰动
      expect(getQueueDepth()['proj_guard']?.pendingCount).toBe(0);
    } finally {
      run.restore();
    }
  });

  it('execute 后 discard（排队未起跑）：cancelInQueue 撤下、任务不跑（丢弃≠不执行）', async () => {
    // 暗角 2：discard 曾只删 proposals Map，队列项仍持 pending 引用照跑。
    const blocker = makeCodeProposal('proj_discard');
    const p = makeCodeProposal('proj_discard');
    rememberProposal(p);
    const h = harness();
    const run = gatedRunFn();
    try {
      enqueue({ agentId: 'agent_test', proposal: blocker, emit: h.broadcast }); // 占住队列
      await execute(p, h, 'r1'); // p 入队排队，尚未起跑
      expect(getQueueDepth()['proj_discard']?.pendingCount).toBe(1);

      await discard(p, h, 'r2');
      expect(getQueueDepth()['proj_discard']?.pendingCount).toBe(0); // 已从队列撤下

      run.releaseAll(); // blocker 跑完，队列推进
      await tick();
      expect(run.started).toEqual([blocker.id]); // p 从未起跑
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
      expect(p.status).toBe('executing'); // 起跑即占住状态

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
});
