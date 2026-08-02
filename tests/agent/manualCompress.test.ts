/**
 * manualCompress（回合外手动压缩内核）回归——斜杠命令补全 plan §2。
 *
 * 承重断言：
 *   1. 闸互斥：占不到闸 → busy；第一次还在摘要时第二次 → busy（双压缩不产双卡）
 *   2. empty 两态区分：user 轮数不足 → tooShort（不调压缩内核）；内核 null → nothingNew
 *   3. 压成三收尾：invalidatePriorReads + sdkSessionId 清号 + 落卡广播（缺一会出
 *     「看不到内容却被告知参考上次读取」/ claudeCode 续传旧上下文使压缩白做）
 *   4. PostCompressOverflowError / 意外异常 → failed，不抛进调用链（gateway 串行链会吞异常）
 *   5. 阈值兜底：twinMain null / contextWindow 缺省 → 200k（显式构造，不依赖默认值）
 *   6. 释闸后续跑：占闸窗口期入队的消息在释闸时落盘 + 转投回合循环
 *
 * ORU_DIR 范式：顶层先设 env（steeringQueue 模块盘记路径加载时固化），再动态 import——
 * 静态 import 提升会让顶层 env 赋值失效（仓库既有陷阱）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent, ChatMessage, Conversation } from '@shared/types';
import { makeSettings } from '../helpers/settings';

process.env.ORU_DIR = join(tmpdir(), `oru-test-manualcompress-${Date.now()}`);

const {
  readHistoryMock,
  appendMock,
  getConvMock,
  updateSidMock,
  updateFoldMock,
  getAgentMock,
  getSettingsMock,
  compressMock,
  invalidateMock,
  buildRunnerMock,
  handOffLoopMock,
  runLoopMock,
  persistMock,
  onHandbackMock,
} = vi.hoisted(() => ({
  readHistoryMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['readHistoryForLLM']>(),
  appendMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['appendMessage']>(),
  getConvMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['getConversation']>(),
  updateSidMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['updateSdkSessionId']>(),
  updateFoldMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['updateFoldedBeforeMessageId']>(),
  getAgentMock: vi.fn<(typeof import('../../electron/main/agent/store/agents'))['getAgent']>(),
  getSettingsMock: vi.fn<(typeof import('../../electron/main/projects/store'))['getSettings']>(),
  compressMock: vi.fn<(typeof import('../../electron/main/agent/context/compress'))['compressIfNeeded']>(),
  invalidateMock: vi.fn<(typeof import('../../electron/main/agent/conversationFileState'))['invalidatePriorReads']>(),
  buildRunnerMock: vi.fn<(typeof import('../../electron/main/ws/handlers/mainTurnAssembly'))['buildMainTurnRunner']>(),
  handOffLoopMock: vi.fn<(typeof import('../../electron/main/ws/handlers/mainTurnAssembly'))['handOffLoopFromSteering']>(),
  runLoopMock: vi.fn<(typeof import('../../electron/main/agent/steeringTurnLoop'))['runSteeringTurnLoop']>(),
  persistMock: vi.fn<(msgs: unknown[]) => Promise<void>>(),
  onHandbackMock: vi.fn(),
}));

vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  readHistoryForLLM: readHistoryMock,
  appendMessage: appendMock,
  getConversation: getConvMock,
  updateSdkSessionId: updateSidMock,
  updateFoldedBeforeMessageId: updateFoldMock,
}));
vi.mock('../../electron/main/agent/store/agents', async (orig) => ({ ...(await orig()), getAgent: getAgentMock }));
vi.mock('../../electron/main/projects/store', async (orig) => ({ ...(await orig()), getSettings: getSettingsMock }));
// 只换压缩内核的决策点，PostCompressOverflowError / KEEP_RECENT_ROUNDS 保持真实（instanceof 承重）。
vi.mock('../../electron/main/agent/context/compress', async (orig) => ({
  ...(await orig()),
  compressIfNeeded: compressMock,
}));
vi.mock('../../electron/main/agent/conversationFileState', async (orig) => ({
  ...(await orig()),
  invalidatePriorReads: invalidateMock,
}));
vi.mock('../../electron/main/ws/handlers/mainTurnAssembly', async (orig) => ({
  ...(await orig()),
  buildMainTurnRunner: buildRunnerMock,
  handOffLoopFromSteering: handOffLoopMock,
}));
vi.mock('../../electron/main/agent/steeringTurnLoop', async (orig) => ({
  ...(await orig()),
  runSteeringTurnLoop: runLoopMock,
}));

const { forceCompressConversation } = await import('../../electron/main/agent/context/manualCompress');
const { createSteeringQueue, steeringKey } = await import('../../electron/main/agent/steeringQueue');
const { PostCompressOverflowError } = await import('../../electron/main/agent/context/compress');

const AGENT = 'a';
const CONV = 'c1';
const KEY = steeringKey(AGENT, CONV);

function mkMsg(id: string, role: ChatMessage['role'], text = 'x'): ChatMessage {
  return { id, conversationId: CONV, role, text, toolCalls: [], createdAt: 0, done: true };
}

/** 造 users 轮（user+assistant 交替）的历史。 */
function historyOf(users: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < users; i += 1) out.push(mkMsg(`u${i}`, 'user'), mkMsg(`a${i}`, 'assistant'));
  return out;
}

const CARD: ChatMessage = {
  ...mkMsg('card1', 'system'),
  kind: 'context-compressed',
  contextCompressed: { compressedMessageIds: ['u0'], summaryText: '摘要', fallback: false },
};

const COMPRESSED_OK = {
  trimmedHistory: [CARD, mkMsg('u5', 'user')],
  notificationMessage: CARD,
  fallback: false,
};

const FAKE_AGENT: Agent = {
  id: AGENT,
  ownerId: 'o',
  name: 'Twin',
  homePath: '/tmp/fake-home',
  systemPromptAppend: null,
  approvalMode: 'work',
  createdAt: 0,
  avatarPath: null,
};

const FAKE_CONV: Conversation = {
  id: CONV,
  ownerId: 'o',
  agentId: AGENT,
  kind: 'sub',
  title: '验收',
  sdkSessionId: null,
  createdAt: 0,
  updatedAt: 0,
};

/** 释闸续跑的最小 MainTurnRunner——buildMainTurnRunner 被 mock，fake 只需满足其返回接口。 */
function fakeRunner() {
  return {
    key: KEY,
    persistConsumed: persistMock,
    onHandback: onHandbackMock,
    runOneTurn: vi.fn(),
  } satisfies ReturnType<(typeof import('../../electron/main/ws/handlers/mainTurnAssembly'))['buildMainTurnRunner']>;
}

const broadcast = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  readHistoryMock.mockResolvedValue(historyOf(6));
  appendMock.mockResolvedValue(undefined);
  getConvMock.mockResolvedValue(FAKE_CONV);
  updateSidMock.mockResolvedValue(undefined);
  updateFoldMock.mockResolvedValue(undefined);
  getAgentMock.mockResolvedValue(FAKE_AGENT);
  getSettingsMock.mockResolvedValue(
    makeSettings({
      modelAssignments: { ...makeSettings().modelAssignments, twinMain: 'm1' },
      models: [
        { id: 'm1', providerId: 'p1', modelId: 'claude-sonnet', label: 'M1', contextWindow: 400_000 },
      ],
    }),
  );
  compressMock.mockResolvedValue(COMPRESSED_OK);
  persistMock.mockResolvedValue(undefined);
  buildRunnerMock.mockReturnValue(fakeRunner());
  handOffLoopMock.mockResolvedValue(undefined);
  runLoopMock.mockResolvedValue('ok');
});

describe('forceCompressConversation', () => {
  it('busy：闸被占（有回合在跑）→ 不动手、不调压缩内核', async () => {
    const queue = createSteeringQueue();
    await queue.beginDirectTurn(KEY); // 模拟有回合在跑
    const r = await forceCompressConversation(AGENT, CONV, broadcast, queue);
    expect(r).toEqual({ status: 'busy' });
    expect(compressMock).not.toHaveBeenCalled();
  });

  it('双压缩互斥：第一次还在摘要时第二次 busy；第一次完成后闸释放', async () => {
    const queue = createSteeringQueue();
    let release!: (v: typeof COMPRESSED_OK) => void;
    compressMock.mockReturnValueOnce(
      new Promise((res) => {
        release = res;
      }),
    );
    const first = forceCompressConversation(AGENT, CONV, broadcast, queue);
    // 第一次已占闸、摘要未归——第二次撞闸
    await vi.waitFor(() => expect(compressMock).toHaveBeenCalledTimes(1));
    await expect(forceCompressConversation(AGENT, CONV, broadcast, queue)).resolves.toEqual({ status: 'busy' });
    release(COMPRESSED_OK);
    await expect(first).resolves.toEqual({ status: 'compressed', fallback: false });
    expect(queue.isRunning(KEY)).toBe(false);
    expect(compressMock).toHaveBeenCalledTimes(1); // 双压缩不产双卡
  });

  it('empty/tooShort：user 轮数不足保留段 → 不调压缩内核，闸照常释放', async () => {
    const queue = createSteeringQueue();
    readHistoryMock.mockResolvedValue(historyOf(3));
    const r = await forceCompressConversation(AGENT, CONV, broadcast, queue);
    expect(r).toEqual({ status: 'empty', emptyReason: 'tooShort' });
    expect(compressMock).not.toHaveBeenCalled();
    expect(queue.isRunning(KEY)).toBe(false);
  });

  it('empty/nothingNew：内核返回 null（上次摘要后没有新内容可压）', async () => {
    const queue = createSteeringQueue();
    compressMock.mockResolvedValue(null);
    const r = await forceCompressConversation(AGENT, CONV, broadcast, queue);
    expect(r).toEqual({ status: 'empty', emptyReason: 'nothingNew' });
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('compressed：落卡 + 广播 + 弃号 + 失效先读 + 水印重钉（三收尾缺一不可）', async () => {
    const queue = createSteeringQueue();
    const r = await forceCompressConversation(AGENT, CONV, broadcast, queue);
    expect(r).toEqual({ status: 'compressed', fallback: false });
    // 阈值：twinMain=m1（contextWindow 400_000）→ 200_000
    expect(compressMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: CONV, threshold: 200_000, force: true }),
    );
    expect(invalidateMock).toHaveBeenCalledWith(CONV);
    expect(updateSidMock).toHaveBeenCalledWith(AGENT, CONV, null);
    expect(updateFoldMock).toHaveBeenCalled();
    expect(appendMock).toHaveBeenCalledWith(AGENT, CONV, CARD);
    expect(broadcast).toHaveBeenCalledWith({ type: 'chat.contextCompressed', conversationId: CONV, message: CARD });
    expect(queue.isRunning(KEY)).toBe(false);
  });

  it('failed：PostCompressOverflowError 不抛进调用链、不落卡，闸照常释放', async () => {
    const queue = createSteeringQueue();
    compressMock.mockRejectedValue(new PostCompressOverflowError('单条消息超装载目标'));
    const r = await forceCompressConversation(AGENT, CONV, broadcast, queue);
    expect(r).toEqual({ status: 'failed' });
    expect(appendMock).not.toHaveBeenCalled();
    expect(queue.isRunning(KEY)).toBe(false);
  });

  it('failed：意外异常同样映射，不抛出（gateway 串行链会吞异常，用户不能石沉大海）', async () => {
    const queue = createSteeringQueue();
    compressMock.mockRejectedValue(new Error('disk on fire'));
    const r = await forceCompressConversation(AGENT, CONV, broadcast, queue);
    expect(r).toEqual({ status: 'failed' });
    expect(queue.isRunning(KEY)).toBe(false);
  });

  it('阈值兜底：twinMain 为 null（OAuth 默认档）→ 200k', async () => {
    const queue = createSteeringQueue();
    getSettingsMock.mockResolvedValue(
      makeSettings({
        modelAssignments: { ...makeSettings().modelAssignments, twinMain: null },
        models: [{ id: 'm1', providerId: 'p1', modelId: 'claude-sonnet', label: 'M1', contextWindow: 400_000 }],
      }),
    );
    await forceCompressConversation(AGENT, CONV, broadcast, queue);
    expect(compressMock).toHaveBeenCalledWith(expect.objectContaining({ threshold: 100_000 }));
  });

  it('阈值兜底：contextWindow 缺省（老数据）→ 200k', async () => {
    const queue = createSteeringQueue();
    getSettingsMock.mockResolvedValue(
      makeSettings({
        modelAssignments: { ...makeSettings().modelAssignments, twinMain: 'm1' },
        models: [{ id: 'm1', providerId: 'p1', modelId: 'claude-sonnet', label: 'M1' }],
      }),
    );
    await forceCompressConversation(AGENT, CONV, broadcast, queue);
    expect(compressMock).toHaveBeenCalledWith(expect.objectContaining({ threshold: 100_000 }));
  });

  it('释闸后续跑：占闸窗口期入队的消息在释闸时落盘 + 转投回合循环（firstText=undefined）', async () => {
    const queue = createSteeringQueue();
    let release!: (v: typeof COMPRESSED_OK) => void;
    compressMock.mockReturnValueOnce(
      new Promise((res) => {
        release = res;
      }),
    );
    const first = forceCompressConversation(AGENT, CONV, broadcast, queue);
    await vi.waitFor(() => expect(compressMock).toHaveBeenCalledTimes(1));
    // 压缩占闸期间入站一条消息 → 正常排队（不丢）
    const decision = await queue.enqueueOrStart(KEY, { clientMsgId: 'm1', text: '压缩期间来的消息', trigger: 'user' });
    expect(decision.action).toBe('enqueued');
    release(COMPRESSED_OK);
    await expect(first).resolves.toEqual({ status: 'compressed', fallback: false });
    // 批落盘（persistConsumed 单源）+ 转投回合循环续跑
    expect(persistMock).toHaveBeenCalledWith([expect.objectContaining({ text: '压缩期间来的消息' })]);
    expect(runLoopMock).toHaveBeenCalledWith(expect.objectContaining({ key: KEY, firstText: undefined }));
  });

  it('释闸时队首是 /loop 模式指令：转投 loop 编排（同 token 持闸），且不等编排跑完（review M1）', async () => {
    const queue = createSteeringQueue();
    let release!: (v: typeof COMPRESSED_OK) => void;
    compressMock.mockReturnValueOnce(
      new Promise((res) => {
        release = res;
      }),
    );
    // 编排永不返回（loop 可能跑数小时）——forceCompressConversation 必须照常返回，
    // 否则 conv.compress 回执与 gateway 串行链被 loop 全程扣押。
    handOffLoopMock.mockReturnValueOnce(new Promise<void>(() => {}));
    const first = forceCompressConversation(AGENT, CONV, broadcast, queue);
    await vi.waitFor(() => expect(compressMock).toHaveBeenCalledTimes(1));
    await queue.enqueueOrStart(KEY, { clientMsgId: 'm1', text: '/loop 目标', trigger: 'user', modeCommand: 'loop' });
    release(COMPRESSED_OK);
    await expect(first).resolves.toEqual({ status: 'compressed', fallback: false });
    expect(handOffLoopMock).toHaveBeenCalledWith(expect.objectContaining({ agentId: AGENT, conversationId: CONV }));
    expect(runLoopMock).not.toHaveBeenCalled();
  });
});
