/**
 * chat.pendingTurnState.query handler 单测——验技术设计 §2 验收：
 * 返回的 running / pendingAsks / inflightPartial 与 steeringQueue / waiters / 半截一致。
 *
 * - running：steeringQueue.isRunning(steeringKey(...))——本对话真占闸为 true，拿下为 false
 * - pendingAsks：waiter 仍在等回答的卡（agentId+conversationId 精确匹配）
 * - inflightPartial：优先 runner 内存镜像 readActivePartial，回落到 turnInflight 草稿
 *
 * 用真实 steeringQueue + 真实 waiter，只 mock runner 内存镜像 / 草稿两个边界。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ServerEvent } from '@shared/protocol';
import { chatHandlers } from '../../electron/main/ws/handlers/chat';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';
import { awaitUserChoice, settleUserChoice } from '../../electron/main/proposals/pendingUserChoice';
import { readActivePartial } from '../../electron/main/agent/runner';
import { readTurnInflight } from '../../electron/main/agent/turnInflight';

vi.mock('../../electron/main/agent/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/agent/runner')>();
  return { ...actual, readActivePartial: vi.fn(actual.readActivePartial) };
});
vi.mock('../../electron/main/agent/turnInflight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/agent/turnInflight')>();
  return { ...actual, readTurnInflight: vi.fn(actual.readTurnInflight) };
});

const q = (header: string) => ({ question: `${header}？`, header, options: [{ label: 'A' }] });
const ans = (label: string) => ({ answers: [{ questionIndex: 0, selectedLabels: [label] }] });

function harness() {
  const replies: Array<{ reqId: string; ev: ServerEvent }> = [];
  const broadcast = (_ev: ServerEvent) => {};
  const reply = (reqId: string, ev: ServerEvent) => replies.push({ reqId, ev });
  return { replies, broadcast, reply };
}

afterEach(async () => {
  // 释放 / 清光本测试造的 running 与 waiter，避免跨用例残留
  for (const key of steeringQueue.listRunningKeys()) {
    await steeringQueue.handBackIfRunning(key, steeringQueue.runToken(key));
  }
});

describe('chat.pendingTurnState.query', () => {
  it('running + 无卡 + 半截：返回与 steer/waiter/内存一致真相', async () => {
    const key = steeringKey('agent', 'conv_q1');
    await steeringQueue.beginDirectTurn(key); // 占闸 → running=true
    const h = harness();

    await chatHandlers['chat.pendingTurnState.query']!(
      { type: 'chat.pendingTurnState.query', reqId: 'r1', agentId: 'agent', conversationId: 'conv_q1' },
      { reply: h.reply, broadcast: h.broadcast },
    );

    expect(h.replies).toHaveLength(1);
    const ev = h.replies[0].ev as { type: string; running: boolean; pendingAsks: unknown[]; inflightPartial: unknown };
    expect(ev.type).toBe('chat.pendingTurnState.result');
    expect(ev.running).toBe(true);
    expect(ev.pendingAsks).toEqual([]);
    // running 但不卡不产出：半截来自内存镜像（mock 保留真实实现，此处无镜像 → null）
    expect(ev.inflightPartial).toBeNull();
  });

  it('有 waiter → pendingAsks 含该卡（askId+questions）', async () => {
    const sig = new AbortController().signal;
    const p = awaitUserChoice('agent', 'conv_q2', 'ask_q2', [q('Q2')], sig);
    const h = harness();

    await chatHandlers['chat.pendingTurnState.query']!(
      { type: 'chat.pendingTurnState.query', reqId: 'r2', agentId: 'agent', conversationId: 'conv_q2' },
      { reply: h.reply, broadcast: h.broadcast },
    );

    const ev = h.replies[0].ev as {
      running: boolean;
      pendingAsks: { askId: string; questions: unknown[] }[];
      inflightPartial: unknown;
    };
    // 不占闸（没 beginDirectTurn）→ running=false；但 waiter 在 → pendingAsks 有卡，卡是「在途待答」信号
    expect(ev.running).toBe(false);
    expect(ev.pendingAsks).toHaveLength(1);
    expect(ev.pendingAsks[0].askId).toBe('ask_q2');
    expect(ev.pendingAsks[0].questions).toEqual([q('Q2')]);

    settleUserChoice('ask_q2', ans('x'));
    await p.catch(() => {});
  });

  it('不同 agent 的 waiter 不混入（agentId+conversationId 精确）', async () => {
    const sig = new AbortController().signal;
    const p = awaitUserChoice('agentB', 'conv_q3', 'ask_q3', [q('Q3')], sig);
    const h = harness();

    await chatHandlers['chat.pendingTurnState.query']!(
      { type: 'chat.pendingTurnState.query', reqId: 'r3', agentId: 'agent', conversationId: 'conv_q3' },
      { reply: h.reply, broadcast: h.broadcast },
    );

    const ev = h.replies[0].ev as { pendingAsks: unknown[] };
    expect(ev.pendingAsks).toEqual([]); // agentB 的卡，agent 查询查不到

    settleUserChoice('ask_q3', ans('x'));
    await p.catch(() => {});
  });

  it('内存镜像优先 → inflightPartial 带 messageId+text+toolCalls', async () => {
    // 注入内存镜像（mock 的 readActivePartial 直接设返回值）
    vi.mocked(readActivePartial).mockReturnValueOnce({
      messageId: 'msg_half',
      partial: { resultText: '写到一半', toolCalls: [{ id: 'tc1', name: 'bash', arguments: '{}' }] },
    });
    const h = harness();

    await chatHandlers['chat.pendingTurnState.query']!(
      { type: 'chat.pendingTurnState.query', reqId: 'r4', agentId: 'agent', conversationId: 'conv_q4' },
      { reply: h.reply, broadcast: h.broadcast },
    );

    const ev = h.replies[0].ev as {
      inflightPartial: { messageId: string; text: string; toolCalls: unknown[] } | null;
    };
    expect(ev.inflightPartial).toEqual({
      messageId: 'msg_half',
      text: '写到一半',
      toolCalls: [{ id: 'tc1', name: 'bash', arguments: '{}' }],
    });
  });

  it('内存镜像空 → 回落 turnInflight 草稿', async () => {
    vi.mocked(readActivePartial).mockReturnValueOnce(null); // 内存不可读
    vi.mocked(readTurnInflight).mockResolvedValueOnce({
      version: 1,
      messageId: 'msg_draft',
      partial: { resultText: '草稿半截', toolCalls: [] },
      meta: { backendType: 'claude', toolProtocol: 'native', modelId: 'm', providerId: 'p' },
      startedAt: 1,
    });
    const h = harness();

    await chatHandlers['chat.pendingTurnState.query']!(
      { type: 'chat.pendingTurnState.query', reqId: 'r5', agentId: 'agent', conversationId: 'conv_q5' },
      { reply: h.reply, broadcast: h.broadcast },
    );

    const ev = h.replies[0].ev as {
      inflightPartial: { messageId: string; text: string } | null;
    };
    expect(ev.inflightPartial).toEqual({ messageId: 'msg_draft', text: '草稿半截', toolCalls: [] });
    expect(readTurnInflight).toHaveBeenCalledWith('agent', 'conv_q5');
  });
});
