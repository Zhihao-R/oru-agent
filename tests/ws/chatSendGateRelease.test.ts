/**
 * chat.send started 分支闸释放回归——修复前 enqueueOrStart 占闸后 appendMessage 落盘失败
 * 无兜底，准入闸永久占住：该对话此后所有消息只入队、永不起回合，直到重启。
 * 修复后与 /loop 分支同款兜底：落盘失败 → drainUnconsumedOnAbort 释放闸 → 下一条消息照常起回合。
 *
 * ORU_DIR 范式：顶层先设 env（steeringQueue 单例盘记落这里），再动态 import。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ORU_DIR = join(tmpdir(), `oru-test-sendgate-${Date.now()}`);

const { getAgentMock, getConvMock, appendMock, assembledMock, getSettingsMock } = vi.hoisted(() => ({
  getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
  getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
  appendMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['appendMessage']>(),
  assembledMock: vi.fn<(typeof import('../../electron/main/ws/handlers/mainTurnAssembly'))['runAssembledMainTurn']>(),
  getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
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
// 起回合前的后端可用前置检查（G28）恒放行——本测试只验落盘失败的闸释放，不涉后端不可用路径。
vi.mock('../../electron/main/agent/backends/readiness', () => ({
  checkBackendReady: vi.fn().mockResolvedValue({ ok: true, hint: '' }),
}));
vi.mock('../../electron/main/memory/dreamScheduler', () => ({ onUserMessage: vi.fn() }));
vi.mock('../../electron/main/memory/captureScheduler', () => ({ onAssistantMessage: vi.fn() }));

import { chatHandlers } from '../../electron/main/ws/handlers/chat';

function callSend(agentId: string, conversationId: string, text: string) {
  const reply = vi.fn();
  const broadcast = vi.fn();
  return {
    reply,
    run: () =>
      chatHandlers['chat.send'](
        { type: 'chat.send', reqId: 'r1', agentId, conversationId, text } as never,
        { reply, broadcast } as never,
      ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAgentMock.mockResolvedValue({ id: 'a', ownerId: 'o' } as never);
  getConvMock.mockResolvedValue({ id: 'c', agentId: 'a' } as never);
  appendMock.mockResolvedValue(undefined);
  assembledMock.mockResolvedValue(undefined as never);
  getSettingsMock.mockResolvedValue({ language: 'en' } as never);
});

describe('chat.send started 分支落盘失败释放闸', () => {
  it('appendMessage 抛错 → 闸被释放，下一条消息照常 started（不被卡成永久排队）', async () => {
    const conversationId = 'c-gate-release';
    appendMock.mockRejectedValueOnce(new Error('disk full'));

    const first = callSend('a', conversationId, '第一条（落盘失败）');
    await expect(first.run()).rejects.toThrow('disk full');
    expect(assembledMock).not.toHaveBeenCalled();

    // 闸已释放：第二条消息应直接起回合（reply ack + 起装配），而不是入队等一个永不结束的回合
    const second = callSend('a', conversationId, '第二条（应正常起回合）');
    await second.run();
    expect(second.reply).toHaveBeenCalledWith('r1', { type: 'ack' });
    expect(assembledMock).toHaveBeenCalledTimes(1);
  });
});
