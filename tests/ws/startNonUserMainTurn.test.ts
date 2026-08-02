import { describe, it, expect, vi, beforeEach } from 'vitest';
/**
 * startNonUserMainTurn（闸外回合：审批续跑 / 播报轮 / [重试]）——S08 · G11 收编后由 steeringQueue
 * 的 beginDirectTurn 锁内原子占闸（替代旧 isConversationBusy 双检）。空闲占闸起回合、忙时让位、
 * 取数失败释放闸不永久卡 running。
 */
const { getAgentMock, getConvMock, runChatPersistMock } = vi.hoisted(() => ({
  getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
  getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
  runChatPersistMock:
    vi.fn<(typeof import('../../electron/main/ws/runChatAndPersist'))['runChatAndPersist']>(),
}));
vi.mock('../../electron/main/agent/store/agents', async (orig) => ({ ...(await orig()), getAgent: getAgentMock, listAgents: vi.fn() }));
vi.mock('../../electron/main/conversations/store', async (orig) => ({ ...(await orig()), getConversation: getConvMock }));
vi.mock('../../electron/main/ws/runChatAndPersist', () => ({ runChatAndPersist: runChatPersistMock }));

import { startNonUserMainTurn } from '../../electron/main/ws/handlers/resumeTurn';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';

describe('startNonUserMainTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getAgentMock.mockResolvedValue({ id: 'a', ownerId: 'o', homePath: '/h' } as any);
    getConvMock.mockResolvedValue({ id: 'c', agentId: 'a' } as any);
    runChatPersistMock.mockResolvedValue('ok');
  });

  it('空闲时占闸起一轮主回合，把 nudge 作 userText、extraDynamicSystemPrompt 透传', async () => {
    const broadcast = vi.fn();
    const conversationId = 'c-idle';
    getConvMock.mockResolvedValue({ id: conversationId, agentId: 'a' } as any);
    await startNonUserMainTurn({
      agentId: 'a', conversationId, broadcast,
      nudgeText: '（系统）后台任务完成，请播报', extraDynamicSystemPrompt: 'ANNOUNCE',
    });
    expect(runChatPersistMock).toHaveBeenCalledTimes(1);
    const arg = runChatPersistMock.mock.calls[0][0];
    expect(arg.userText).toBe('（系统）后台任务完成，请播报');
    expect(arg.extraDynamicSystemPrompt).toBe('ANNOUNCE');
    expect(broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.started', conversationId }));
    // 回合末 concludeTurn 排空 → 闸释放
    expect(steeringQueue.isRunning(steeringKey('a', conversationId))).toBe(false);
  });

  it('对话忙（闸已被占）则让位：不起回合、不广播 chat.started', async () => {
    const broadcast = vi.fn();
    const conversationId = 'c-busy';
    // 先占闸模拟已有回合在跑
    await steeringQueue.beginDirectTurn(steeringKey('a', conversationId));
    await startNonUserMainTurn({ agentId: 'a', conversationId, broadcast });
    expect(runChatPersistMock).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.started' }));
  });

  it('取数失败释放闸：getAgent 抛错 → 上抛且闸释放（不永久卡 running、后续 send 仍能起回合）', async () => {
    const conversationId = 'c-throw';
    const key = steeringKey('a', conversationId);
    getAgentMock.mockRejectedValueOnce(new Error('取 agent 失败'));
    await expect(
      startNonUserMainTurn({ agentId: 'a', conversationId, broadcast: vi.fn() }),
    ).rejects.toThrow('取 agent 失败');
    expect(steeringQueue.isRunning(key)).toBe(false); // 闸已释放，不永久卡运行中
    expect(runChatPersistMock).not.toHaveBeenCalled();
  });
});
