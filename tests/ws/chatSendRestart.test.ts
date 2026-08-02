/**
 * chat.send 连发撤起分支（S1 桌面同源）——窗口内无产出在飞回合被撤起重跑。
 *
 * 验：
 *  - restart 决策后：同步杀在飞回合（abortConversation）→ 落盘新消息 → 以新 token 起装配；
 *    不广播 chat.steering.added（消息直接进新回合，非排队）。
 *  - custody 过户：被撤回合已消费的渠道 origin 不因撤起丢失（随重起回合清表情/回发）。
 *  - /stop（chat.abort）在撤起后照常可用：drain + 刹车，不受撤起影响。
 *
 * 范式同 chatSendBackendReady.test.ts（ORU_DIR + mock 落盘/装配，真 steeringQueue + 真 liveTurnMark）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { TriggerOrigin } from '@shared/types';

process.env.ORU_DIR = join(tmpdir(), `oru-test-chatrestart-${Date.now()}`);

const { getAgentMock, getConvMock, appendMock, assembledMock, getSettingsMock, readyMock, abortMock } = vi.hoisted(() => ({
  getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
  getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
  appendMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['appendMessage']>(),
  assembledMock: vi.fn<(typeof import('../../electron/main/ws/handlers/mainTurnAssembly'))['runAssembledMainTurn']>(),
  getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
  readyMock: vi.fn<(typeof import('../../electron/main/agent/backends/readiness'))['checkBackendReady']>(),
  abortMock: vi.fn<(typeof import('../../electron/main/agent/runner'))['abortConversation']>(),
}));
vi.mock('../../electron/main/agent/store/agents', async (orig) => ({ ...(await orig()), getAgent: getAgentMock }));
vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  getConversation: getConvMock,
  appendMessage: appendMock,
}));
vi.mock('../../electron/main/ws/handlers/mainTurnAssembly', async (orig) => ({
  ...(await orig()),
  runAssembledMainTurn: assembledMock,
}));
vi.mock('../../electron/main/projects/store', async (orig) => ({ ...(await orig()), getSettings: getSettingsMock }));
vi.mock('../../electron/main/agent/backends/readiness', () => ({ checkBackendReady: readyMock }));
vi.mock('../../electron/main/agent/runner', async (orig) => ({ ...(await orig()), abortConversation: abortMock }));
vi.mock('../../electron/main/memory/dreamScheduler', () => ({ onUserMessage: vi.fn() }));
vi.mock('../../electron/main/memory/captureScheduler', () => ({ onAssistantMessage: vi.fn() }));

import { chatHandlers } from '../../electron/main/ws/handlers/chat';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';
import { beginLiveTurn, noteLiveTurnOrigin, peekLiveTurnOrigins } from '../../electron/main/agent/liveTurnMark';

const KEY = steeringKey('a', 'c');
const feishuOrigin: TriggerOrigin = { platform: 'feishu', chatId: 'oc_1', platformMessageId: 'om_1' };

function callSend(text: string, clientMsgId?: string) {
  const reply = vi.fn();
  const broadcast = vi.fn();
  return {
    reply,
    broadcast,
    run: () =>
      chatHandlers['chat.send'](
        { type: 'chat.send', reqId: 'r1', agentId: 'a', conversationId: 'c', text, clientMsgId } as never,
        { reply, broadcast } as never,
      ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAgentMock.mockResolvedValue({ id: 'a', ownerId: 'o' } as never);
  getConvMock.mockResolvedValue({ id: 'c', agentId: 'a' } as never);
  appendMock.mockResolvedValue(undefined);
  assembledMock.mockResolvedValue('ok');
  getSettingsMock.mockResolvedValue({ language: 'zh' } as never);
  readyMock.mockResolvedValue({ ok: true, hint: '' });
  abortMock.mockReturnValue(true);
});

describe('chat.send 连发撤起（S1 restart 分支）', () => {
  it('窗口内无产出 → 撤起重跑：杀旧回合、落盘新消息、新 token 起装配、不广播排队', async () => {
    // 第 1 条：空闲起回合（装配被 mock——手动开条模拟「在飞且无产出」）
    const first = callSend('在', 'cm_1');
    await first.run();
    expect(assembledMock).toHaveBeenCalledTimes(1);
    const token1 = steeringQueue.runToken(KEY);
    beginLiveTurn(KEY, token1);

    // 第 2 条：restart 分支
    const second = callSend('吗', 'cm_2');
    await second.run();

    // 同步杀了在飞回合；落盘第 2 条；以翻新 token 起新装配（带更全历史）
    expect(abortMock).toHaveBeenCalledWith('a', 'c');
    expect(appendMock).toHaveBeenCalledWith('a', 'c', expect.objectContaining({ role: 'user', text: '吗' }));
    expect(assembledMock).toHaveBeenCalledTimes(2);
    expect(assembledMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ runToken: token1 + 1, firstText: '吗' }),
    );
    expect(second.reply).toHaveBeenCalledWith('r1', { type: 'ack' });
    // 不广播 chat.steering.added（消息直接进新回合）；不触发 handback
    const types = second.broadcast.mock.calls.map(([ev]) => (ev as { type: string }).type);
    expect(types).not.toContain('chat.steering.added');
    expect(types).not.toContain('chat.queue.handback');
    // 闸仍由新回合持有（不经过 idle 倒手）
    expect(steeringQueue.isRunning(KEY)).toBe(true);
    expect(steeringQueue.runToken(KEY)).toBe(token1 + 1);
    await steeringQueue.drainUnconsumedOnAbort(KEY); // 清场
  });

  it('custody 过户：被撤回合已消费的渠道 origin 不丢（随重起回合清表情/回发）', async () => {
    const first = callSend('在', 'cm_1');
    await first.run();
    const token1 = steeringQueue.runToken(KEY);
    beginLiveTurn(KEY, token1);
    noteLiveTurnOrigin(KEY, token1, feishuOrigin); // 在飞回合消费过一条飞书消息

    const second = callSend('吗', 'cm_2');
    await second.run();

    // 撤起后 custody 仍挂着那条渠道 origin（条目已过户到新 token）
    expect(peekLiveTurnOrigins(KEY)).toEqual([feishuOrigin]);
    await steeringQueue.drainUnconsumedOnAbort(KEY);
  });

  it('/stop 在撤起后照常可用：交还 + 释闸，不受撤起影响', async () => {
    const first = callSend('在', 'cm_1');
    await first.run();
    beginLiveTurn(KEY, steeringQueue.runToken(KEY));
    const second = callSend('吗', 'cm_2');
    await second.run();
    expect(steeringQueue.isRunning(KEY)).toBe(true);

    const reply = vi.fn();
    const broadcast = vi.fn();
    await chatHandlers['chat.abort'](
      { type: 'chat.abort', reqId: 'r2', agentId: 'a', conversationId: 'c' } as never,
      { reply, broadcast } as never,
    );
    expect(steeringQueue.isRunning(KEY)).toBe(false); // 闸已释
    expect(reply).toHaveBeenCalledWith('r2', expect.objectContaining({ type: 'chat.abortResult' }));
  });

  it('有产出（打标）→ 第 2 条走现状排队，不杀在飞回合', async () => {
    const first = callSend('在', 'cm_1');
    await first.run();
    const token1 = steeringQueue.runToken(KEY);
    beginLiveTurn(KEY, token1);
    const { markLiveTurnProduced } = await import('../../electron/main/agent/liveTurnMark');
    markLiveTurnProduced(KEY, token1);

    const second = callSend('吗', 'cm_2');
    await second.run();

    expect(abortMock).not.toHaveBeenCalled();
    expect(assembledMock).toHaveBeenCalledTimes(1); // 没起新装配
    expect(steeringQueue.pendingCount(KEY)).toBe(1); // 走了排队
    const types = second.broadcast.mock.calls.map(([ev]) => (ev as { type: string }).type);
    expect(types).toContain('chat.steering.added');
    await steeringQueue.drainUnconsumedOnAbort(KEY);
  });
});
