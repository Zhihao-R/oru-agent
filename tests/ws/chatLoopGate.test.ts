/**
 * /loop 过准入闸（S09 · G71）回归——修 bug 前 /loop 忙时也直接起编排链、与在跑回合并发写同一
 * 对话历史。现在 /loop 经 enqueueOrStart 原子裁决（2026-07-28 去特殊化 T2）：
 *  - 忙时：入普通消息队列（带模式指令标记，不作插话）、不起编排、不报错——由 concludeTurn
 *    在它处切批转投编排（见 tests/loop/loopBusyQueue.test.ts）。
 *  - 空闲：占闸起编排、编排结束释放闸。
 *
 * ORU_DIR 范式：顶层先设 env（steeringQueue 单例盘记落这里），再动态 import。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatAttachment } from '@shared/types';

process.env.ORU_DIR = join(tmpdir(), `oru-test-loopgate-${Date.now()}`);

const { getAgentMock, getConvMock, appendMock, loopMock, getSettingsMock, saveAttachmentsMock, visionMock } =
  vi.hoisted(() => ({
    getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
    getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
    appendMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['appendMessage']>(),
    loopMock: vi.fn<(typeof import('../../electron/main/loop/orchestrate'))['runLoopOrchestration']>(),
    getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
    saveAttachmentsMock: vi.fn<(typeof import('../../electron/main/conversations/attachments'))['saveAttachments']>(),
    visionMock:
      vi.fn<(typeof import('../../electron/main/agent/backends/visionSupport'))['currentTwinSupportsVision']>(),
  }));
vi.mock('../../electron/main/agent/store/agents', async (orig) => ({ ...(await orig()), getAgent: getAgentMock }));
vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  getConversation: getConvMock,
  appendMessage: appendMock,
}));
// chat.ts 走 runLoopOrchestrationAndRelease（编排+收尾单源）：mock 里如实履行「收尾释闸」契约
// （编排本体换成 loopMock），释闸语义的真实现另有 orchestrateClarify.test 覆盖。
vi.mock('../../electron/main/loop/orchestrate', async () => {
  const { steeringQueue, steeringKey } = await import('../../electron/main/agent/steeringQueue');
  return {
    runLoopOrchestration: loopMock,
    runLoopOrchestrationAndRelease: async (args: { agentId: string; conversationId: string; runToken: number }) => {
      try {
        await loopMock(args as never);
      } finally {
        await steeringQueue.handBackIfRunning(steeringKey(args.agentId, args.conversationId), args.runToken);
      }
    },
  };
});
vi.mock('../../electron/main/projects/store', async (orig) => ({ ...(await orig()), getSettings: getSettingsMock }));
vi.mock('../../electron/main/conversations/attachments', async (orig) => ({
  ...(await orig()),
  saveAttachments: saveAttachmentsMock,
}));
vi.mock('../../electron/main/agent/backends/visionSupport', () => ({ currentTwinSupportsVision: visionMock }));
vi.mock('../../electron/main/memory/dreamScheduler', () => ({ onUserMessage: vi.fn() }));
vi.mock('../../electron/main/memory/captureScheduler', () => ({ onAssistantMessage: vi.fn() }));

import { chatHandlers } from '../../electron/main/ws/handlers/chat';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';

function callSend(
  agentId: string,
  conversationId: string,
  text: string,
  attachments?: Array<{ base64: string; mediaType: string }>,
) {
  const reply = vi.fn();
  const broadcast = vi.fn();
  return {
    reply,
    broadcast,
    run: () =>
      chatHandlers['chat.send'](
        { type: 'chat.send', reqId: 'r1', agentId, conversationId, text, attachments } as never,
        { reply, broadcast } as never,
      ),
  };
}

/** saveAttachments 落盘后的形态——/loop 路径与普通消息共用同一批引用。 */
const savedImg: ChatAttachment = {
  kind: 'image',
  relPath: 'attachments/m1/a.png',
  mediaType: 'image/png',
  bytes: 10,
  filename: 'a.png',
};

beforeEach(() => {
  vi.clearAllMocks();
  getAgentMock.mockResolvedValue({ id: 'a', ownerId: 'o' } as never);
  getConvMock.mockResolvedValue({ id: 'c', agentId: 'a' } as never);
  appendMock.mockResolvedValue(undefined);
  getSettingsMock.mockResolvedValue({ language: 'en' } as never);
  saveAttachmentsMock.mockResolvedValue([savedImg]);
  visionMock.mockResolvedValue(true);
});

describe('/loop 过准入闸（G71）', () => {
  it('忙时不起编排、入队不报错（T2：模式指令标记、chat.steering.added 广播）', async () => {
    const conversationId = 'c-loop-busy';
    const key = steeringKey('a', conversationId);
    await steeringQueue.beginDirectTurn(key); // 模拟已有回合在跑
    const { reply, broadcast, run } = callSend('a', conversationId, '/loop 修好滚动');
    await run();
    expect(loopMock).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith('r1', { type: 'ack' });
    expect(broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.steering.added', conversationId }),
    );
    // 入队为模式指令：不作插话、不计待读入（interrupt 死循环回归见 loopBusyQueue.test）
    expect(steeringQueue.pendingCount(key)).toBe(1);
    expect(steeringQueue.pendingUserCount(key)).toBe(0);
    const drained = await steeringQueue.drainUnconsumedOnAbort(key);
    expect(drained[0]).toMatchObject({ text: '/loop 修好滚动', modeCommand: 'loop' });
  });

  it('带附件的 /loop（直起路径）：图落盘 + 随 /loop 消息进历史 + 编排收到（拆解据图定标准）', async () => {
    const conversationId = 'c-loop-att-direct';
    const key = steeringKey('a', conversationId);
    loopMock.mockResolvedValue(undefined);
    const { run } = callSend('a', conversationId, '/loop 照这张图建表', [{ base64: 'x', mediaType: 'image/png' }]);
    await run();
    // 附件命名用 clientMsgId（起回合/入队/loop 三路统一）
    expect(saveAttachmentsMock).toHaveBeenCalledWith('a', conversationId, expect.any(String), [
      { base64: 'x', mediaType: 'image/png' },
    ]);
    // 干活轮从历史读图，故 /loop 那条消息必须带附件落盘
    const persisted = appendMock.mock.calls.map((c) => c[2]);
    expect(persisted.at(-1)).toMatchObject({ role: 'user', attachments: [savedImg] });
    expect(loopMock).toHaveBeenCalledWith(expect.objectContaining({ attachments: [savedImg] }));
    await vi.waitFor(() => expect(steeringQueue.isRunning(key)).toBe(false));
  });

  it('带附件的 /loop（排队路径）：附件随队列项带到转投侧', async () => {
    const conversationId = 'c-loop-att-queued';
    const key = steeringKey('a', conversationId);
    await steeringQueue.beginDirectTurn(key); // 模拟忙
    const { run } = callSend('a', conversationId, '/loop 照这张图建表', [{ base64: 'x', mediaType: 'image/png' }]);
    await run();
    const drained = await steeringQueue.drainUnconsumedOnAbort(key);
    expect(drained[0]).toMatchObject({ modeCommand: 'loop', attachments: [savedImg] });
  });

  it('无视觉模型带图发 /loop：与普通消息同口径硬拒，不落盘不起编排', async () => {
    visionMock.mockResolvedValue(false);
    const conversationId = 'c-loop-att-novision';
    const { reply, run } = callSend('a', conversationId, '/loop 照这张图建表', [
      { base64: 'x', mediaType: 'image/png' },
    ]);
    await run();
    expect(reply).toHaveBeenCalledWith('r1', expect.objectContaining({ type: 'error' }));
    expect(saveAttachmentsMock).not.toHaveBeenCalled();
    expect(loopMock).not.toHaveBeenCalled();
  });

  it('空闲时占闸起编排、编排结束释放闸', async () => {
    const conversationId = 'c-loop-idle';
    const key = steeringKey('a', conversationId);
    let releaseLoop: () => void = () => {};
    loopMock.mockReturnValue(new Promise<void>((r) => (releaseLoop = r)));
    const { reply, run } = callSend('a', conversationId, '/loop 修好滚动');
    await run();
    expect(loopMock).toHaveBeenCalledWith(expect.objectContaining({ goal: '修好滚动', conversationId }));
    expect(reply).toHaveBeenCalledWith('r1', { type: 'ack' });
    expect(steeringQueue.isRunning(key)).toBe(true); // 编排期间占闸，杜绝并发回合
    releaseLoop();
    await vi.waitFor(() => expect(steeringQueue.isRunning(key)).toBe(false)); // 结束释放闸
  });
});
