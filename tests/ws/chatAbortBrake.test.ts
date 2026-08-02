/**
 * 对话级刹车（G17）——chat.abort 编排回归
 *
 * 理想架构 subagent.html#PFail：按停=对话级刹车，该对话派出的后台任务 / 排队未起跑的
 * 派工 / 后台命令一并终止。chat.abort 此前只 drain steering + 停当前轮，本测试钉住扩展后
 * 的编排与「完全静默」呈现（PM 拍板）：
 * 1. 停当前轮（既有 abortConversation）；
 * 2. 取消该对话运行中的 subagent 任务（复用 cancelTask 内核）＋撤它悬着的审批卡
 *    ＋markAnnounced 抑制播报轮（用户刚按停，Oru 不得转头起一轮说「任务被取消了」）；
 * 3. 撤该对话排队未起跑的派工，proposal 走 pending → rejected 合法终态；
 * 4. 杀该对话自己的后台 bash（复用对话删除路径的 killBashForConversation，不写第二份）；
 * 5. 静默：编排层全程不 appendMessage、不 notifyTaskTerminal；其他对话一概不动。
 *    「刹车取消的任务不写对话报告卡」的 runner 层真实路径断言在
 *    subagentRunnerBrake.test.ts（本文件 stub 掉了 runner，兜不住那条）；
 * 6. 双撤销背靠背零 await：被 abort 任务 settle 时 runWithDequeue finally 推进队列，
 *    同对话排队项不得在间隙被提升起跑。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BashProposal, CodeActionProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';

const ORU_DIR = join(tmpdir(), `oru-test-chat-abort-brake-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

// ─── mock：只桩掉有真实副作用/需断言的边界，其余保留真实实现 ─────────────────

vi.mock('../../electron/main/agent/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/agent/runner')>();
  return {
    ...actual,
    abortConversation: vi.fn(() => true) satisfies typeof actual.abortConversation,
  };
});

// 运行中任务的取消：内核已由 subagentRunnerBrake.test.ts 单独回归，这里桩掉、只验编排接线
vi.mock('../../electron/main/tasks/subagentRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/subagentRunner')>();
  return {
    ...actual,
    cancelTasksForConversation: vi.fn((conversationId: string) =>
      conversationId === 'conv_target' ? ['task_active_1'] : [],
    ) satisfies typeof actual.cancelTasksForConversation,
  };
});

vi.mock('../../electron/main/tasks/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/store')>();
  return {
    ...actual,
    // 跨 macrotask：真实 markAnnounced 走文件写队列（多层 await）——mock 立即 resolve
    // 会把「await 间隙让队列推进抢跑」的真实竞态藏掉（M2 回归依赖这个时序）
    markAnnounced: vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 0));
    }) satisfies typeof actual.markAnnounced,
  };
});

vi.mock('../../electron/main/proposals/executeBashProposal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/proposals/executeBashProposal')>();
  return {
    ...actual,
    killBashForConversation: vi.fn(() => {}) satisfies typeof actual.killBashForConversation,
  };
});

vi.mock('../../electron/main/tasks/taskAnnouncer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/taskAnnouncer')>();
  return {
    ...actual,
    notifyTaskTerminal: vi.fn(() => {}) satisfies typeof actual.notifyTaskTerminal,
  };
});

vi.mock('../../electron/main/conversations/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/conversations/store')>();
  return {
    ...actual,
    appendMessage: vi.fn(async () => {}) satisfies typeof actual.appendMessage,
  };
});

import { chatHandlers } from '../../electron/main/ws/handlers/chat';
import { rememberProposal } from '../../electron/main/proposals/registry';
import { abortConversation } from '../../electron/main/agent/runner';
import { cancelTasksForConversation } from '../../electron/main/tasks/subagentRunner';
import { markAnnounced } from '../../electron/main/tasks/store';
import { killBashForConversation } from '../../electron/main/proposals/executeBashProposal';
import { notifyTaskTerminal } from '../../electron/main/tasks/taskAnnouncer';
import { appendMessage } from '../../electron/main/conversations/store';
import {
  enqueue,
  getQueueDepth,
  __setRunFnForTest,
  __resetQueuesForTest,
} from '../../electron/main/tasks/queue';
import type { Reply } from '../../electron/main/ws/server';

let seq = 0;
function makeCodeProposal(conversationId: string): CodeActionProposal {
  return {
    id: `prop_brake_${seq++}`,
    ownerId: 'local-user',
    conversationId,
    title: '改代码',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    kind: 'code',
    targetProjectId: 'proj_brake',
    risk: 'low',
    rollbackable: true,
    rawPlan: '测试计划',
  } satisfies CodeActionProposal;
}

/** 运行中 subagent 任务悬在主对话的命令审批卡（回流卡）——刹车要一并撤掉 */
function makeSubagentBashProposal(taskId: string): BashProposal {
  return {
    id: `prop_sub_bash_${seq++}`,
    ownerId: 'local-user',
    conversationId: 'conv_target',
    title: '执行命令',
    description: '测试用',
    createdAt: 1,
    status: 'pending',
    kind: 'bash',
    command: 'rm -rf build',
    isDestructive: true,
    isReadOnly: false,
    segments: [{ text: 'rm -rf build', destructive: true }],
    triggeredBySubagent: { taskId, description: '测试任务' },
  } satisfies BashProposal;
}

function harness() {
  const events: ServerEvent[] = [];
  const replies: Array<{ reqId: string; ev: ServerEvent }> = [];
  const broadcast = (ev: ServerEvent) => {
    events.push(ev);
  };
  const reply: Reply = (reqId, ev) => {
    replies.push({ reqId, ev: ev as ServerEvent });
  };
  return { events, replies, broadcast, reply };
}

const abort = (conversationId: string, h: ReturnType<typeof harness>) =>
  chatHandlers['chat.abort']!(
    { type: 'chat.abort', reqId: 'r_abort', agentId: 'agent_test', conversationId },
    { reply: h.reply, broadcast: h.broadcast },
  );

const tick = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  vi.clearAllMocks();
  __resetQueuesForTest();
});

describe('chat.abort = 对话级刹车', () => {
  it('停当前轮 + 取消运行中任务（撤卡/抑播报）+ 撤排队派工 + 杀后台 bash；其他对话不动；全程静默', async () => {
    const h = harness();
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const restore = __setRunFnForTest(async (item) => {
      started.push(item.proposal.id);
      await new Promise<void>((r) => gates.push(r));
    });
    try {
      // 排队现场：blocker（conv_other）占住 proj_brake → p1（conv_target）/ p2（conv_other）排队
      const blocker = makeCodeProposal('conv_other');
      const p1 = makeCodeProposal('conv_target');
      const p2 = makeCodeProposal('conv_other');
      for (const p of [blocker, p1, p2]) {
        enqueue({ agentId: 'agent_test', proposal: p, emit: h.broadcast });
      }
      expect(getQueueDepth()['proj_brake']?.pendingCount).toBe(2);
      // 运行中任务 task_active_1 悬在主对话的命令审批卡
      const subCard = makeSubagentBashProposal('task_active_1');
      rememberProposal(subCard);

      await abort('conv_target', h);

      // 1. 停当前轮（既有行为）+ 回执形态不变
      expect(vi.mocked(abortConversation)).toHaveBeenCalledWith('agent_test', 'conv_target');
      expect(h.replies).toHaveLength(1);
      expect(h.replies[0].ev).toMatchObject({
        type: 'chat.abortResult',
        conversationId: 'conv_target',
        items: [], // S08 · G14：回执携带类型化 items（此处无未消费项）
      });

      // 2. 运行中任务：取消 + 撤悬卡 + 抑制播报
      expect(vi.mocked(cancelTasksForConversation)).toHaveBeenCalledWith('conv_target');
      expect(subCard.status).toBe('rejected'); // 悬着的回流审批卡被撤成终态
      expect(vi.mocked(markAnnounced)).toHaveBeenCalledWith('task_active_1'); // 播报轮抑制

      // 3. 排队派工：目标对话的撤下并走合法终态；其他对话的原样排队
      expect(p1.status).toBe('rejected');
      expect(p2.status).toBe('pending');
      expect(getQueueDepth()['proj_brake']?.pendingCount).toBe(1);

      // 4. 后台 bash：恰好杀目标对话的（一次、且只有这一个 conversationId）
      expect(vi.mocked(killBashForConversation).mock.calls).toEqual([['conv_target']]);

      // 5. 静默：不落任何对话消息、不触发播报轮
      expect(vi.mocked(appendMessage)).not.toHaveBeenCalled();
      expect(vi.mocked(notifyTaskTerminal)).not.toHaveBeenCalled();
      const messageEvents = h.events.filter((e) =>
        ['chat.taskReport', 'chat.started'].includes(e.type as string),
      );
      expect(messageEvents).toEqual([]);

      // 队列不因刹车卡死：blocker 跑完后 p2 照常起跑，p1 永不起跑
      gates.splice(0).forEach((r) => r());
      await tick();
      gates.splice(0).forEach((r) => r());
      await tick();
      expect(started).toEqual([blocker.id, p2.id]);
    } finally {
      restore();
    }
  });

  it('被 abort 任务 settle 推进队列时，同对话排队项不得被放行（双撤销间零 await）', async () => {
    const h = harness();
    const started: string[] = [];
    const gates: Array<() => void> = [];
    const restore = __setRunFnForTest(async (item) => {
      started.push(item.proposal.id);
      await new Promise<void>((r) => gates.push(r));
    });
    try {
      // 同对话现场：blocker（conv_target）正在跑，p1（conv_target）排在它后面
      const blocker = makeCodeProposal('conv_target');
      const p1 = makeCodeProposal('conv_target');
      enqueue({ agentId: 'agent_test', proposal: blocker, emit: h.broadcast });
      enqueue({ agentId: 'agent_test', proposal: p1, emit: h.broadcast });
      // 刹车取消 blocker 的瞬间它 settle（真实路径：abort 传导让 runTask resolve）——
      // runWithDequeue finally 随即在 microtask 里推进队列。若 chat.abort 在两个撤销
      // 之间夹了 await，p1 会在间隙被提升起跑、双双抓空。
      vi.mocked(cancelTasksForConversation).mockImplementationOnce((conversationId) => {
        if (conversationId !== 'conv_target') return [];
        gates.splice(0).forEach((r) => r());
        return ['task_blocker'];
      });

      await abort('conv_target', h);

      // p1 必须在队列推进之前被同步撤下——被提升起跑即竞态复现
      expect(started).toEqual([blocker.id]);
      expect(p1.status).toBe('rejected');
      await tick();
      expect(started).toEqual([blocker.id]); // 队列推进之后也没有放行
      expect(getQueueDepth()['proj_brake']?.running).toBe(false); // 队列不因刹车卡死
    } finally {
      restore();
    }
  });

  it('对话空刹（无任务无排队无 bash 登记）：既有 abort 行为不变、零额外副作用', async () => {
    const h = harness();
    await abort('conv_empty', h);
    expect(vi.mocked(abortConversation)).toHaveBeenCalledWith('agent_test', 'conv_empty');
    expect(h.replies[0].ev).toMatchObject({ type: 'chat.abortResult', conversationId: 'conv_empty' });
    expect(vi.mocked(markAnnounced)).not.toHaveBeenCalled();
    expect(vi.mocked(appendMessage)).not.toHaveBeenCalled();
    // killBashForConversation 幂等（无登记时 no-op），编排统一调用即可
    expect(vi.mocked(killBashForConversation).mock.calls).toEqual([['conv_empty']]);
  });
});
