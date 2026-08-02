/**
 * 对话级刹车（G17）——cancelQueuedForConversation 回归
 *
 * 队列按 project 组织（projectKey），但每个排队项的 proposal 都带 conversationId：
 * 按停要把该对话「排队未起跑」的派工从所有 project 队列里撤下，否则按停后它们照常
 * 起跑，违背「对话级刹车」。验：
 * 1. 只撤目标对话的排队项（跨 project 扫），其他对话的照常排队、照常起跑；
 * 2. 被撤项永不起跑，队列不因此卡死；
 * 3. 返回被撤项的 proposal（状态流转由调用方经 transitionProposal 处理，本函数不碰状态）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CodeActionProposal } from '@shared/types';

// 终态播报会打真实 store——掐掉，其余符号保留真实实现
vi.mock('../../electron/main/tasks/taskAnnouncer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/taskAnnouncer')>();
  return {
    ...actual,
    notifyTaskTerminal: vi.fn(() => {}) satisfies typeof actual.notifyTaskTerminal,
  };
});

import {
  enqueue,
  getQueueDepth,
  cancelQueuedForConversation,
  __setRunFnForTest,
  __resetQueuesForTest,
} from '../../electron/main/tasks/queue';

let seq = 0;
function makeCodeProposal(conversationId: string, targetProjectId: string): CodeActionProposal {
  return {
    id: `prop_qcc_${seq++}`,
    ownerId: 'local-user',
    conversationId,
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

/** 可控 runFn：任务卡在闸门里直到 release，记录跑过哪些 proposalId */
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
const emit = () => {};

beforeEach(() => {
  __resetQueuesForTest();
});

describe('cancelQueuedForConversation（对话级刹车的排队撤下）', () => {
  it('跨 project 撤目标对话的排队项；其他对话不动、队列照常推进；被撤项永不起跑', async () => {
    const run = gatedRunFn();
    try {
      // proj_1：blocker（conv_other）占住 → p1（conv_target）/ p2（conv_other）排队
      const blocker1 = makeCodeProposal('conv_other', 'proj_1');
      const p1 = makeCodeProposal('conv_target', 'proj_1');
      const p2 = makeCodeProposal('conv_other', 'proj_1');
      // proj_2：blocker（conv_other）占住 → p3（conv_target）排队
      const blocker2 = makeCodeProposal('conv_other', 'proj_2');
      const p3 = makeCodeProposal('conv_target', 'proj_2');
      for (const p of [blocker1, p1, p2, blocker2, p3]) {
        enqueue({ agentId: 'agent_test', proposal: p, emit });
      }
      expect(getQueueDepth()['proj_1']?.pendingCount).toBe(2);
      expect(getQueueDepth()['proj_2']?.pendingCount).toBe(1);

      // 刹 conv_target：p1 / p3 被跨 project 撤下并返回；conv_other 的一概不动
      const removed = cancelQueuedForConversation('conv_target');
      expect(removed.map((p) => p.id).sort()).toEqual([p1.id, p3.id].sort());
      expect(getQueueDepth()['proj_1']?.pendingCount).toBe(1);
      expect(getQueueDepth()['proj_2']?.pendingCount).toBe(0);
      // 本函数不碰状态——流转（transitionProposal）是调用方的事
      expect(p1.status).toBe('pending');

      // 队列不卡死：blocker 跑完后 p2 照常起跑，p1 / p3 永不起跑
      run.releaseAll();
      await tick();
      run.releaseAll();
      await tick();
      expect(run.started.sort()).toEqual([blocker1.id, blocker2.id, p2.id].sort());
    } finally {
      run.restore();
    }
  });

  it('对话没有排队项时返回空数组（幂等）', () => {
    expect(cancelQueuedForConversation('conv_nothing')).toEqual([]);
  });
});
