/**
 * chat.send 起回合前的「后端可用?」前置检查（S34 · G28，锚 conversation-flow.html#Backend）。
 *
 * 目标态：后端不可用时，起回合入口在 user 落盘之前就回执并释放闸——user 不进历史、队列无损。
 * 回归修复前：检查在 runChatLocked 内部（runner.ts），user 已 appendMessage 才失败 → 历史里
 * 残留一条永远得不到回复的 user 消息。
 *
 * ORU_DIR 范式：顶层先设 env（steeringQueue 单例盘记落这里），再动态 import。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ORU_DIR = join(tmpdir(), `oru-test-backendready-${Date.now()}`);

const { getAgentMock, getConvMock, appendMock, assembledMock, getSettingsMock, readyMock } = vi.hoisted(() => ({
  getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
  getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
  appendMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['appendMessage']>(),
  assembledMock: vi.fn<(typeof import('../../electron/main/ws/handlers/mainTurnAssembly'))['runAssembledMainTurn']>(),
  getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
  readyMock: vi.fn<(typeof import('../../electron/main/agent/backends/readiness'))['checkBackendReady']>(),
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
vi.mock('../../electron/main/memory/dreamScheduler', () => ({ onUserMessage: vi.fn() }));
vi.mock('../../electron/main/memory/captureScheduler', () => ({ onAssistantMessage: vi.fn() }));

import { chatHandlers } from '../../electron/main/ws/handlers/chat';
import { steeringQueue } from '../../electron/main/agent/steeringQueue';

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
  readyMock.mockResolvedValue({ ok: true, hint: '' });
});

describe('chat.send 后端可用前置检查（G28）', () => {
  it('后端不可用 → user 不落盘、不起装配、回执 AGENT_NO_AUTH，闸随即释放', async () => {
    readyMock.mockResolvedValueOnce({ ok: false, hint: '模型后端未配置' });

    const first = callSend('a', 'c-not-ready', '第一条（后端挂）');
    await first.run();

    // 历史无损：user 消息没落盘、回合没起
    expect(appendMock).not.toHaveBeenCalled();
    expect(assembledMock).not.toHaveBeenCalled();
    // 保留重连入口：回执带原因
    expect(first.reply).toHaveBeenCalledWith('r1', {
      type: 'error',
      code: 'AGENT_NO_AUTH',
      message: '模型后端未配置',
    });

    // 队列无损：闸已释放，后端恢复后下一条照常起回合
    const second = callSend('a', 'c-not-ready', '第二条（后端已恢复）');
    await second.run();
    expect(second.reply).toHaveBeenCalledWith('r1', { type: 'ack' });
    expect(assembledMock).toHaveBeenCalledTimes(1);
  });

  it('并发：检查期间 Esc 清了闸（isRunning=false）→ 不落盘、不起装配（await 后重检）', async () => {
    // enqueueOrStart 真的占了闸；模拟 checkBackendReady 之后 isRunning 变 false（abort 抢先清）
    const spy = vi.spyOn(steeringQueue, 'isRunning').mockReturnValueOnce(false);
    const { reply, run } = callSend('a', 'c-abort-race', '发出后立刻 Esc');
    await run();
    expect(appendMock).not.toHaveBeenCalled();
    expect(assembledMock).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('后端可用 → 正常起回合（落盘 + 起装配）', async () => {
    const { reply, run } = callSend('a', 'c-ready', '正常消息');
    await run();
    expect(appendMock).toHaveBeenCalledTimes(1);
    expect(assembledMock).toHaveBeenCalledTimes(1);
    expect(reply).toHaveBeenCalledWith('r1', { type: 'ack' });
  });
});
