/** @vitest-environment jsdom */
/**
 * pending 指代队列（src/aside/pendingReferents.ts）——技术方案 §7 / §10：
 * 流式中连点按序排队、轮结束按序 flush（每张卡各起一轮，卡序 = 点击序）、
 * flush 后响应里的指代卡回流灌桶（浮层 / promote 后开头可见这张卡）、
 * AGENT_BUSY 重新入队不丢、flush 与浮层开关解耦（队列驻模块级内存）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { AsideReferent } from '@shared/types';

const ws = vi.hoisted(() => ({
  log: [] as ClientRequestPayload[],
  impl: (async (_p: ClientRequestPayload): Promise<ServerEventPayload> => {
    throw new Error('ws.impl 未配置');
  }) as (p: ClientRequestPayload) => Promise<ServerEventPayload>,
}));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> => {
      ws.log.push(payload);
      return (await ws.impl(payload)) as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { enqueueAsideReferent, resetAsideReferentQueueForTest } from '@/aside/pendingReferents';
import { useChatStore } from '@/stores/chatStore';

const CONV = 'conv-aside-1';

function referent(label: string): AsideReferent {
  return { type: 'blank', label };
}

function item(label: string) {
  return { agentId: 'a1', conversationId: CONV, referent: referent(label), screenshot: undefined };
}

function sentLabels(): string[] {
  return ws.log
    .filter((p) => p.type === 'aside.addReferent')
    .map((p) => (p as { referent: AsideReferent }).referent.label);
}

/** 与主进程同形态的成功响应：result 带已落盘的指代卡（渲染端拿它灌桶） */
function resultFor(p: ClientRequestPayload): ServerEventPayload {
  if (p.type !== 'aside.addReferent') throw new Error(`未预期的请求：${p.type}`);
  return {
    type: 'aside.addReferent.result',
    message: {
      id: `card-${p.referent.label}-${ws.log.length}`,
      conversationId: p.conversationId,
      role: 'user',
      kind: 'aside-referent',
      asideReferent: p.referent,
      text: p.referent.label,
      toolCalls: [],
      createdAt: Date.now(),
      done: true,
    },
  };
}

/** 桶里已回流的指代卡 label 序（卡序 = 点击序的可见面） */
function bucketCardLabels(): string[] {
  return (useChatStore.getState().conversations[CONV] ?? [])
    .filter((m) => m.kind === 'aside-referent')
    .map((m) => m.asideReferent!.label);
}

/** 模拟一轮流式：开 → 关（markDone 把 streamingMessageId 置空 = 轮结束信号） */
function startRound(msgId: string): void {
  useChatStore.getState().startAssistantMessage(CONV, msgId);
}
async function endRound(msgId: string): Promise<void> {
  useChatStore.getState().markDone(CONV, msgId);
  // flush 是订阅触发的异步动作，等微任务收尾
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  ws.log = [];
  ws.impl = async (p) => resultFor(p);
  useChatStore.setState({ conversations: {}, streamingMessageIdByConv: {}, pendingByConv: {} });
  resetAsideReferentQueueForTest();
});

afterEach(() => {
  resetAsideReferentQueueForTest();
});

describe('pending 指代队列', () => {
  it('无流式轮在跑：入队即发（等价于直接 addReferent），响应里的指代卡回流灌桶', async () => {
    enqueueAsideReferent(item('A'));
    await new Promise((r) => setTimeout(r, 0)); // request → 灌桶的微任务链收尾
    expect(sentLabels()).toEqual(['A']);
    expect(ws.log[0]).toMatchObject({
      type: 'aside.addReferent',
      agentId: 'a1',
      conversationId: CONV,
    });
    // 卡进桶：浮层立即可见、promote 后 ChatArea（桶非空不拉历史）开头完整
    expect(bucketCardLabels()).toEqual(['A']);
  });

  it('流式中连点多处：按序排队不发；轮结束逐张 flush，每张各起一轮、卡序=点击序', async () => {
    startRound('m1');
    enqueueAsideReferent(item('一'));
    enqueueAsideReferent(item('二'));
    enqueueAsideReferent(item('三'));
    await Promise.resolve();
    expect(sentLabels()).toEqual([]); // 流式中绝不发（主进程忙时不落盘）

    // 用户那轮结束 → 队首发出（它自己起一轮）
    await endRound('m1');
    expect(sentLabels()).toEqual(['一']);

    // 第一张卡的回合流式中：第二张不抢跑
    startRound('m2');
    await Promise.resolve();
    expect(sentLabels()).toEqual(['一']);
    await endRound('m2');
    expect(sentLabels()).toEqual(['一', '二']);

    startRound('m3');
    await endRound('m3');
    expect(sentLabels()).toEqual(['一', '二', '三']);
    // 三张卡按点击序回流进桶
    await new Promise((r) => setTimeout(r, 0));
    expect(bucketCardLabels()).toEqual(['一', '二', '三']);
  });

  it('flush 撞 AGENT_BUSY：重新入队不丢，下一轮结束再试成功', async () => {
    let busyOnce = true;
    ws.impl = async (p) => {
      if (p.type !== 'aside.addReferent') throw new Error(`未预期的请求：${p.type}`);
      if (busyOnce) {
        busyOnce = false;
        const err = new Error('AGENT_BUSY: 该对话正在生成中') as Error & { code?: string };
        err.code = 'AGENT_BUSY';
        throw err;
      }
      return resultFor(p);
    };
    startRound('m1');
    enqueueAsideReferent(item('A'));
    await endRound('m1'); // 第一次 flush：撞忙（轮结束与用户开口竞态）→ 重新入队
    expect(sentLabels()).toEqual(['A']);

    // 撞忙那轮（用户抢话的轮）结束 → 重试成功
    startRound('m2');
    await endRound('m2');
    expect(sentLabels()).toEqual(['A', 'A']);
  });

  it('其他错误：丢弃不重试（与短评同一克制口径），后续卡不等任何轮结束信号立即放行', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let failFirst = true;
    ws.impl = async (p) => {
      if (p.type !== 'aside.addReferent') throw new Error(`未预期的请求：${p.type}`);
      if (failFirst) {
        failFirst = false;
        throw new Error('网络断了');
      }
      return resultFor(p);
    };
    startRound('m1');
    enqueueAsideReferent(item('坏'));
    enqueueAsideReferent(item('好'));
    // '坏' 发送失败被丢弃。失败的 addReferent 没起回合，"轮结束"信号不会再来——
    // '好' 必须在丢弃后自动放行，这里不再喂任何 startRound/endRound
    await endRound('m1');
    await new Promise((r) => setTimeout(r, 0)); // 丢弃 → 补 flush 的微任务链收尾
    expect(sentLabels()).toEqual(['坏', '好']);
    warn.mockRestore();
  });

  it('队列驻模块级内存：流式中入队后即便没有任何浮层动作，轮结束照常 flush（与浮层开关 / promote 解耦）', async () => {
    // 不存在浮层对象可关——本测试本身就证明队列不依赖浮层生命周期：
    // 入队后唯一的外部事件是"轮结束"，flush 仍无条件发生
    startRound('m1');
    enqueueAsideReferent(item('遗留指认'));
    await Promise.resolve();
    expect(sentLabels()).toEqual([]);
    await endRound('m1');
    expect(sentLabels()).toEqual(['遗留指认']);
  });
});
