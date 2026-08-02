/**
 * artifact.updateFromNarrative 过准入闸回归（整体验收发现的绕闸入口）——修复前直调
 * runChatAndPersist：对话忙时点「据文稿更新」撞 AGENT_BUSY 红条、它跑着时用户消息又反向撞车。
 * 修复后经 beginDirectTurn 占闸 + runAssembledMainTurn 统一装配：
 *  - 忙时：不建组、回 ok:false 友好提示（PM 2026-07-13 拍板：提示稍后再点，不排队）。
 *  - 空闲：占闸起装配；建组失败（并发约束）释放闸不留死锁。
 *
 * ORU_DIR 范式：顶层先设 env（steeringQueue 单例盘记落这里），再动态 import。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

process.env.ORU_DIR = join(tmpdir(), `oru-test-artifactgate-${Date.now()}`);

const {
  listAgentsMock,
  getAgentMock,
  getConvMock,
  appendMock,
  assembledMock,
  getSettingsMock,
  submitMock,
  readAnnMock,
} = vi.hoisted(() => ({
  listAgentsMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['listAgents']>(),
  getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
  getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
  appendMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['appendMessage']>(),
  assembledMock: vi.fn<(typeof import('../../electron/main/ws/handlers/mainTurnAssembly'))['runAssembledMainTurn']>(),
  getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
  submitMock: vi.fn<(typeof import('../../electron/main/deck/submissions'))['submitAnnotations']>(),
  readAnnMock: vi.fn<(typeof import('../../electron/main/deck/annotations'))['readAnnotations']>(),
}));
vi.mock('../../electron/main/agent/store/agents', async (orig) => ({
  ...(await orig()),
  listAgents: listAgentsMock,
  getAgent: getAgentMock,
}));
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
vi.mock('../../electron/main/deck/submissions', async (orig) => ({
  ...(await orig()),
  submitAnnotations: submitMock,
  getSubmissionView: vi.fn<(typeof import('../../electron/main/deck/submissions'))['getSubmissionView']>(
    () => null,
  ),
}));
vi.mock('../../electron/main/deck/annotations', async (orig) => ({ ...(await orig()), readAnnotations: readAnnMock }));
vi.mock('../../electron/main/deck/store', async (orig) => ({
  ...(await orig()),
  resolveDeckPath: vi.fn(async () => join(tmpdir(), 'no-such-deck')),
}));

import { artifactHandlers } from '../../electron/main/ws/handlers/artifact';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';

function callUpdate(conversationId: string) {
  const reply = vi.fn();
  const broadcast = vi.fn();
  return {
    reply,
    run: () =>
      artifactHandlers['artifact.updateFromNarrative'](
        { type: 'artifact.updateFromNarrative', reqId: 'r1', artifactId: 'deck-1', conversationId } as never,
        { reply, broadcast } as never,
      ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listAgentsMock.mockResolvedValue({ activeId: 'a', agents: [] } as never);
  getAgentMock.mockResolvedValue({ id: 'a', ownerId: 'o' } as never);
  getConvMock.mockResolvedValue({ id: 'c', agentId: 'a' } as never);
  appendMock.mockResolvedValue(undefined);
  assembledMock.mockResolvedValue({ kind: 'ok' } as never);
  getSettingsMock.mockResolvedValue({ language: 'zh' } as never);
  submitMock.mockResolvedValue({ groupId: 'g1' } as never);
  readAnnMock.mockResolvedValue([] as never);
});

describe('artifact.updateFromNarrative 过准入闸', () => {
  it('忙时不建组、回 ok:false 友好提示（不再撞 AGENT_BUSY）', async () => {
    const conversationId = 'c-artifact-busy';
    const key = steeringKey('a', conversationId);
    expect(await steeringQueue.beginDirectTurn(key)).toBe(1); // 占住闸模拟忙（返回归属 token）

    const call = callUpdate(conversationId);
    await call.run();

    expect(submitMock).not.toHaveBeenCalled();
    expect(assembledMock).not.toHaveBeenCalled();
    expect(call.reply).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ type: 'artifact.submitAnnotations.result', ok: false }),
    );
    await steeringQueue.drainUnconsumedOnAbort(key);
  });

  it('空闲时占闸走统一装配（firstText + extraDynamicSystemPrompt）', async () => {
    const conversationId = 'c-artifact-idle';
    const call = callUpdate(conversationId);
    await call.run();

    expect(call.reply).toHaveBeenCalledWith('r1', { type: 'ack' });
    expect(assembledMock).toHaveBeenCalledTimes(1);
    const args = assembledMock.mock.calls[0][0];
    expect(args.firstText).toBe('据当前文稿更新这份演示设计');
    expect(args.extraDynamicSystemPrompt).toContain('g1');
    await steeringQueue.drainUnconsumedOnAbort(steeringKey('a', conversationId));
  });

  it('建组冲突时释放闸：随后 update 不被卡死、能再占闸', async () => {
    const conversationId = 'c-artifact-conflict';
    const err = Object.assign(new Error('in progress'), { code: 'ARTIFACT_SUBMISSION_IN_PROGRESS' });
    submitMock.mockRejectedValueOnce(err);

    const first = callUpdate(conversationId);
    await first.run();
    expect(first.reply).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ type: 'artifact.submitAnnotations.result', ok: false }),
    );

    // 闸已释放：第二次 update 应正常占闸走到装配（而不是被判「忙」）
    const second = callUpdate(conversationId);
    await second.run();
    expect(second.reply).toHaveBeenCalledWith('r1', { type: 'ack' });
    expect(assembledMock).toHaveBeenCalledTimes(1);
    await steeringQueue.drainUnconsumedOnAbort(steeringKey('a', conversationId));
  });
});
