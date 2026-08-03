/**
 * chat.send started 分支自动命名接线回归（2026-08-03 命名前移）。
 *
 * 本次改动的核心是「命名触发点从回合收尾前移到 chat.send started 分支、首条 user 落盘后」。
 * 这份测试钉住的就是这条接线本身：started 起回合、user 消息落盘后，`chat.send` 真的调用了
 * maybeAutoNameConversation / maybeAutoNameAsideConversation 且各只一次、带正确的 userText。
 *
 * 为何需要：既有命名测试（__smoke_auto_name_conversation__ / autoNameAside.test）全是**直接调用**
 * 命名函数，绕过了 chat.send——若有人删掉/挪走 chat.ts 里的两行 `void maybeAutoName*`，
 * 那些测试照样全绿。这条测试是本次改动「触发点」的唯一回归防线。
 *
 * ORU_DIR 顶层先设（steeringQueue 单例盘记落这里），再动态 import。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ORU_DIR = join(tmpdir(), `oru-test-sendautoname-${Date.now()}`);

const {
  getAgentMock,
  getConvMock,
  appendMock,
  assembledMock,
  getSettingsMock,
  nameMock,
  nameAsideMock,
} = vi.hoisted(() => ({
  getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
  getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
  appendMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['appendMessage']>(),
  assembledMock: vi.fn<(typeof import('../../electron/main/ws/handlers/mainTurnAssembly'))['runAssembledMainTurn']>(),
  getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
  nameMock: vi.fn(),
  nameAsideMock: vi.fn(),
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
vi.mock('../../electron/main/agent/backends/readiness', () => ({
  checkBackendReady: vi.fn().mockResolvedValue({ ok: true, hint: '' }),
}));
vi.mock('../../electron/main/agent/autoNameConversation', () => ({
  maybeAutoNameConversation: nameMock,
  maybeAutoNameAsideConversation: nameAsideMock,
}));
vi.mock('../../electron/main/memory/dreamScheduler', () => ({ onUserMessage: vi.fn() }));
vi.mock('../../electron/main/memory/captureScheduler', () => ({ onAssistantMessage: vi.fn() }));

import { chatHandlers } from '../../electron/main/ws/handlers/chat';

function callSend(agentId: string, conversationId: string, text: string) {
  const reply = vi.fn();
  const broadcast = vi.fn();
  return {
    reply,
    broadcast,
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
  nameMock.mockResolvedValue(undefined);
  nameAsideMock.mockResolvedValue(undefined);
});

describe('chat.send started 分支自动命名接线', () => {
  it('started 起回合、user 落盘后 → 两个命名函数各触发一次、带该条 userText', async () => {
    const { run, broadcast } = callSend('a', 'c-autoname', '我想做一个理财 app');
    await run();

    // 起了回合（started→reply ack + 起装配）
    expect(assembledMock).toHaveBeenCalledTimes(1);
    // sub 首条与 aside 首条各触发一次，都带这条 user 消息文本
    expect(nameMock).toHaveBeenCalledTimes(1);
    expect(nameMock).toHaveBeenCalledWith({
      agentId: 'a',
      conversationId: 'c-autoname',
      userText: '我想做一个理财 app',
      broadcast,
    });
    expect(nameAsideMock).toHaveBeenCalledTimes(1);
    expect(nameAsideMock).toHaveBeenCalledWith({
      agentId: 'a',
      conversationId: 'c-autoname',
      userText: '我想做一个理财 app',
      broadcast,
    });
  });
});
