/**
 * chat.queue.readmit（S08 · G14 放行待处理项）回归——钉住 review 抓出的两个真问题：
 *  1. 起回合时附件必须随首轮带进装配（否则放行带图项时图片没喂给模型）。
 *  2. 起回合前 getAgent/getConversation 抛错必须释放刚占的闸（否则对话永久卡「运行中」）。
 *
 * ORU_DIR 范式：顶层先设 env（steeringQueue 单例的文件盘记落这里），再动态 import。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-readmit-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const { getAgentMock, getConvMock, appendMock, assembleMock } = vi.hoisted(() => ({
  getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
  getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
  appendMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['appendMessage']>(),
  assembleMock:
    vi.fn<(typeof import('../../electron/main/ws/handlers/mainTurnAssembly'))['runAssembledMainTurn']>(),
}));
vi.mock('../../electron/main/agent/store/agents', async (orig) => ({ ...(await orig()), getAgent: getAgentMock }));
vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  getConversation: getConvMock,
  appendMessage: appendMock,
}));
vi.mock('../../electron/main/ws/handlers/mainTurnAssembly', () => ({ runAssembledMainTurn: assembleMock }));

import { chatHandlers } from '../../electron/main/ws/handlers/chat';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';

const ATT = [
  { kind: 'image' as const, relPath: 'x.png', mediaType: 'image/png' as const, bytes: 1, filename: 'x.png' },
];

function callReadmit(agentId: string, conversationId: string, item: unknown) {
  const reply = vi.fn();
  const broadcast = vi.fn();
  return {
    reply,
    broadcast,
    run: () =>
      chatHandlers['chat.queue.readmit'](
        { type: 'chat.queue.readmit', reqId: 'r1', agentId, conversationId, item } as never,
        { reply, broadcast } as never,
      ),
  };
}

describe('chat.queue.readmit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentMock.mockResolvedValue({ id: 'a', ownerId: 'o', homePath: '/h' } as never);
    appendMock.mockResolvedValue(undefined as never);
    assembleMock.mockResolvedValue('ok');
  });

  it('空闲放行带附件的项：起回合，附件随首轮带进装配（不丢图）', async () => {
    const conversationId = 'c-readmit-att';
    getConvMock.mockResolvedValue({ id: conversationId, agentId: 'a' } as never);
    const item = { serverId: 's1', clientMsgId: 'm1', text: '看这张图', trigger: 'user', attachments: ATT };
    const h = callReadmit('a', conversationId, item);
    await h.run();
    expect(assembleMock).toHaveBeenCalledTimes(1);
    const arg = assembleMock.mock.calls[0][0];
    expect(arg.firstText).toBe('看这张图');
    expect(arg.attachments).toEqual(ATT); // 附件透传到装配，模型能看到图
  });

  it('起回合前 getAgent 抛错：释放刚占的闸（不永久卡运行中）、不起装配', async () => {
    const conversationId = 'c-readmit-throw';
    const key = steeringKey('a', conversationId);
    getConvMock.mockResolvedValue({ id: conversationId, agentId: 'a' } as never);
    getAgentMock.mockRejectedValueOnce(new Error('取 agent 失败'));
    const item = { serverId: 's1', clientMsgId: 'm1', text: '定时结果', trigger: 'scheduled' };
    const h = callReadmit('a', conversationId, item);
    await expect(h.run()).rejects.toThrow('取 agent 失败');
    expect(steeringQueue.isRunning(key)).toBe(false); // 闸已释放
    expect(assembleMock).not.toHaveBeenCalled();
  });

  it('忙时放行：入队等回合末合并、不起第二回合（广播 steering.added）', async () => {
    const conversationId = 'c-readmit-busy';
    const key = steeringKey('a', conversationId);
    await steeringQueue.beginDirectTurn(key); // 先占闸模拟正忙
    const item = { serverId: 's1', clientMsgId: 'm1', text: '定时结果', trigger: 'scheduled' };
    const h = callReadmit('a', conversationId, item);
    await h.run();
    expect(assembleMock).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.steering.added' }));
    expect(steeringQueue.pendingCount(key)).toBe(1);
  });
});
