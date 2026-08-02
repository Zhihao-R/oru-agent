/**
 * 删除对话 = 对话级刹车（理想架构 subagent.html#PFail）——conv.delete 编排回归
 *
 * 删除是比桌面按停更强的意图：对话都要删了，运行中的派工 / 排队未起跑的任务 / 后台 bash
 * 必须一并停，否则逃逸任务会往已删对话写消息。此前 conv.delete 只在 store 层 killBash，
 * 不停当前轮、不取消任务、不撤排队。本测试钉住：
 * 1. conv.delete 触发完整 brakeConversation（停当前轮 + 取消任务 + 撤排队 + 杀 bash）；
 * 2. 刹车在删数据之前（先停后删）——被刹任务的 brakeCancelled 静默由此在数据仍在时生效；
 * 3. 编排层静默：删除路径不追加对话消息。
 *
 * 修复前红：conv.delete 不调 abortConversation / cancelTasks / cancelQueued。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promises as fs } from 'node:fs';
import type { ServerEvent } from '@shared/protocol';

const ORU_DIR = join(tmpdir(), `oru-test-conv-delete-brake-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

// 刹车各件（内核语义由 chatAbortBrake / subagentRunnerBrake 单测）——这里桩掉只验删除路径接线
vi.mock('../../electron/main/agent/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/agent/runner')>();
  return {
    ...actual,
    abortConversation: vi.fn(() => true) satisfies typeof actual.abortConversation,
  };
});
vi.mock('../../electron/main/tasks/subagentRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/subagentRunner')>();
  return {
    ...actual,
    cancelTasksForConversation: vi.fn(() => []) satisfies typeof actual.cancelTasksForConversation,
  };
});
vi.mock('../../electron/main/tasks/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/queue')>();
  return {
    ...actual,
    cancelQueuedForConversation: vi.fn(() => []) satisfies typeof actual.cancelQueuedForConversation,
  };
});
vi.mock('../../electron/main/proposals/executeBashProposal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/proposals/executeBashProposal')>();
  return {
    ...actual,
    killBashForConversation: vi.fn(() => {}) satisfies typeof actual.killBashForConversation,
  };
});
// deleteConversation 桩掉：验刹车相对它的调用顺序（先停后删），不真删磁盘
vi.mock('../../electron/main/conversations/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/conversations/store')>();
  return {
    ...actual,
    deleteConversation: vi.fn(async () => {}) satisfies typeof actual.deleteConversation,
    clearConversation: vi.fn(async (agentId, convId) => ({ id: convId }) as Awaited<ReturnType<typeof actual.clearConversation>>) satisfies typeof actual.clearConversation,
    appendMessage: vi.fn(async () => {}) satisfies typeof actual.appendMessage,
  };
});
vi.mock('../../electron/main/conversations/attachments', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/conversations/attachments')>();
  return {
    ...actual,
    deleteConversationImages: vi.fn(async () => {}) satisfies typeof actual.deleteConversationImages,
  };
});

import { conversationHandlers } from '../../electron/main/ws/handlers/conversations';
import { abortConversation } from '../../electron/main/agent/runner';
import { cancelTasksForConversation } from '../../electron/main/tasks/subagentRunner';
import { cancelQueuedForConversation } from '../../electron/main/tasks/queue';
import { killBashForConversation } from '../../electron/main/proposals/executeBashProposal';
import { deleteConversation, clearConversation, appendMessage } from '../../electron/main/conversations/store';
import type { Reply } from '../../electron/main/ws/server';

let agentId: string;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});
beforeEach(() => vi.clearAllMocks());

function harness() {
  const events: ServerEvent[] = [];
  const replies: Array<{ reqId: string; ev: ServerEvent }> = [];
  const broadcast = (ev: ServerEvent) => events.push(ev);
  const reply: Reply = (reqId, ev) => replies.push({ reqId, ev: ev as ServerEvent });
  return { events, replies, broadcast, reply };
}

describe('conv.delete = 对话级刹车', () => {
  it('删除触发完整刹车：停当前轮 + 取消任务 + 撤排队 + 杀 bash（都指向该会话）', async () => {
    const h = harness();
    await conversationHandlers['conv.delete']!(
      { type: 'conv.delete', reqId: 'r_del', agentId, conversationId: 'conv_del' },
      { reply: h.reply, broadcast: h.broadcast },
    );

    expect(vi.mocked(abortConversation)).toHaveBeenCalledWith(agentId, 'conv_del');
    expect(vi.mocked(cancelTasksForConversation)).toHaveBeenCalledWith('conv_del');
    expect(vi.mocked(cancelQueuedForConversation)).toHaveBeenCalledWith('conv_del');
    expect(vi.mocked(killBashForConversation).mock.calls).toEqual([['conv_del']]);
    expect(vi.mocked(deleteConversation)).toHaveBeenCalledWith(agentId, 'conv_del');
  });

  it('刹车在删数据之前（先停后删）', async () => {
    const h = harness();
    await conversationHandlers['conv.delete']!(
      { type: 'conv.delete', reqId: 'r_del', agentId, conversationId: 'conv_del' },
      { reply: h.reply, broadcast: h.broadcast },
    );
    const brakeAt = vi.mocked(cancelTasksForConversation).mock.invocationCallOrder[0];
    const deleteAt = vi.mocked(deleteConversation).mock.invocationCallOrder[0];
    expect(brakeAt).toBeLessThan(deleteAt);
  });

  it('编排层静默：删除路径不追加对话消息', async () => {
    const h = harness();
    await conversationHandlers['conv.delete']!(
      { type: 'conv.delete', reqId: 'r_del', agentId, conversationId: 'conv_del' },
      { reply: h.reply, broadcast: h.broadcast },
    );
    expect(vi.mocked(appendMessage)).not.toHaveBeenCalled();
  });
});

describe('conv.clear = 对话级刹车（与 delete 对齐）', () => {
  it('清空触发完整刹车：停当前轮 + 取消任务 + 撤排队 + 杀 bash（都指向该会话）', async () => {
    const h = harness();
    await conversationHandlers['conv.clear']!(
      { type: 'conv.clear', reqId: 'r_clr', agentId, conversationId: 'conv_clr' },
      { reply: h.reply, broadcast: h.broadcast },
    );

    expect(vi.mocked(abortConversation)).toHaveBeenCalledWith(agentId, 'conv_clr');
    expect(vi.mocked(cancelTasksForConversation)).toHaveBeenCalledWith('conv_clr');
    expect(vi.mocked(cancelQueuedForConversation)).toHaveBeenCalledWith('conv_clr');
    expect(vi.mocked(killBashForConversation).mock.calls).toEqual([['conv_clr']]);
    expect(vi.mocked(clearConversation)).toHaveBeenCalledWith(agentId, 'conv_clr');
  });

  it('刹车在清历史之前（先停后清）', async () => {
    const h = harness();
    await conversationHandlers['conv.clear']!(
      { type: 'conv.clear', reqId: 'r_clr', agentId, conversationId: 'conv_clr' },
      { reply: h.reply, broadcast: h.broadcast },
    );
    const brakeAt = vi.mocked(cancelTasksForConversation).mock.invocationCallOrder[0];
    const clearAt = vi.mocked(clearConversation).mock.invocationCallOrder[0];
    expect(brakeAt).toBeLessThan(clearAt);
  });

  it('编排层静默：清空路径不追加对话消息（被刹任务不写卡到刚清空的对话）', async () => {
    const h = harness();
    await conversationHandlers['conv.clear']!(
      { type: 'conv.clear', reqId: 'r_clr', agentId, conversationId: 'conv_clr' },
      { reply: h.reply, broadcast: h.broadcast },
    );
    expect(vi.mocked(appendMessage)).not.toHaveBeenCalled();
  });
});
