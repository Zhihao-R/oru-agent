/**
 * 统一回合装配的在飞回合打标（连发合并 S1）——「无产出」判定单点与撤起链 origins 交接。
 *
 * 验：
 *  - runOneTurn 起跑开条、终了销条（isLiveTurnRestartable 的起落）。
 *  - 本对话流过 chat.delta / chat.toolCall → 打标「有产出」（别的对话的事件不串标）。
 *  - 撤起链 custody origins 进 turnInputs（deliverAssistantToChannels 收到——回发与清表情不失联）。
 *  - drain 的间隙插入 origin 同样入账。
 *  - 被打过标的新回合 supersede 后被撤回合的迟到收尾（旧 token）动不到新条。
 *
 * ORU_DIR 范式：顶层先设 env（steeringQueue 单例盘记落这里），再动态 import。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent, Conversation, TriggerOrigin } from '@shared/types';

process.env.ORU_DIR = join(tmpdir(), `oru-test-livemark-assembly-${Date.now()}`);

const { runChatMock, turnArgsMock, deliverMock, remoteProposalMock, appendMock, clearItemsSpy } = vi.hoisted(() => ({
  runChatMock: vi.fn<(typeof import('../../electron/main/ws/runChatAndPersist'))['runChatAndPersist']>(),
  turnArgsMock: vi.fn<(typeof import('../../electron/main/ws/handlers/turnArgs'))['buildMainChatTurnArgs']>(),
  deliverMock: vi.fn<(typeof import('../../electron/main/ws/handlers/channelOutbound'))['deliverAssistantToChannels']>(),
  remoteProposalMock: vi.fn<(typeof import('../../electron/main/ws/handlers/channelOutbound'))['handleChannelProposalIfRemote']>(),
  appendMock: vi.fn<(typeof import('../../electron/main/conversations/store'))['appendMessage']>(),
  clearItemsSpy: vi.fn<(typeof import('../../electron/main/platform/channelProcessing'))['clearProcessingForItems']>(),
}));
vi.mock('../../electron/main/ws/runChatAndPersist', async (orig) => ({
  ...(await orig()),
  runChatAndPersist: runChatMock,
}));
vi.mock('../../electron/main/ws/handlers/turnArgs', async (orig) => ({
  ...(await orig()),
  buildMainChatTurnArgs: turnArgsMock,
}));
vi.mock('../../electron/main/ws/handlers/channelOutbound', async (orig) => ({
  ...(await orig()),
  deliverAssistantToChannels: deliverMock,
  handleChannelProposalIfRemote: remoteProposalMock,
}));
vi.mock('../../electron/main/conversations/store', async (orig) => ({
  ...(await orig()),
  appendMessage: appendMock,
}));
vi.mock('../../electron/main/platform/channelProcessing', async (orig) => ({
  ...(await orig()),
  clearProcessingForItems: clearItemsSpy,
}));

import { buildMainTurnRunner } from '../../electron/main/ws/handlers/mainTurnAssembly';
import { steeringQueue, steeringKey } from '../../electron/main/agent/steeringQueue';
import {
  beginLiveTurn,
  drainLiveTurn,
  isLiveTurnRestartable,
  noteLiveTurnOrigin,
  supersedeLiveTurn,
} from '../../electron/main/agent/liveTurnMark';

const agent = { id: 'a', ownerId: 'o' } as Agent;
const conversation = { id: 'c', agentId: 'a' } as Conversation;
const key = steeringKey(agent.id, conversation.id);
const originOf = (messageId: string): TriggerOrigin => ({
  platform: 'feishu',
  chatId: 'oc_1',
  platformMessageId: messageId,
});

/** 占一个真闸（生产单例队列），返回 runToken 供装配 deps。 */
async function occupyGate(): Promise<number> {
  const d = await steeringQueue.enqueueOrStart(key, { clientMsgId: `cm-${Date.now()}-${Math.random()}`, text: '起', trigger: 'user' });
  if (d.action === 'enqueued') throw new Error('闸被前序用例占用——用例间必须释闸');
  return d.token;
}

beforeEach(() => {
  vi.clearAllMocks();
  appendMock.mockResolvedValue(undefined);
  deliverMock.mockResolvedValue(undefined);
  remoteProposalMock.mockResolvedValue(false);
  // turnArgs 只搭骨架：emit 直挂 broadcast（流经装配的打标包装），onAssistantPersisted 空跑。
  turnArgsMock.mockImplementation((args) => ({
    emit: (ev: Parameters<typeof args.broadcast>[0]) => args.broadcast(ev),
    onAssistantPersisted: async () => {},
  }) as unknown as ReturnType<typeof turnArgsMock>);
  // 对齐真实 runChatAndPersist 的「成功路径落盘后调 onAssistantPersisted」——装配的渠道回发挂在那里。
  runChatMock.mockImplementation(async (args) => {
    await args.onAssistantPersisted?.({ text: '回复' } as Parameters<NonNullable<typeof args.onAssistantPersisted>>[0]);
    return 'ok';
  });
});

describe('装配层在飞回合打标（S1 干净判定单点）', () => {
  it('runOneTurn 起跑开条（窗口内可撤）、终了销条（不可撤）', async () => {
    const token = await occupyGate();
    const runner = buildMainTurnRunner({ agentId: agent.id, agent, conversation, broadcast: vi.fn(), runToken: token });
    await runner.runOneTurn({ userText: '在' });
    // 回合已终：条已销——队列裁决读不到条目，判不可撤
    expect(isLiveTurnRestartable(key)).toBe(false);
    await steeringQueue.handBackIfRunning(key, token); // 释闸，免污下一个用例
  });

  it('回合进行中本对话流过 chat.delta → 打标有产出（不可撤）；别的对话的 delta 不串标', async () => {
    const token = await occupyGate();
    let duringTurn = false;
    runChatMock.mockImplementation(async (args) => {
      // 回合在飞：此刻应可撤（尚未有任何产出）
      expect(isLiveTurnRestartable(key)).toBe(true);
      args.emit({ type: 'chat.delta', conversationId: 'someone-else', messageId: 'x', textChunk: '别' } as never);
      expect(isLiveTurnRestartable(key)).toBe(true); // 别对话的事件不打标
      args.emit({ type: 'chat.delta', conversationId: conversation.id, messageId: 'x', textChunk: '你' } as never);
      duringTurn = isLiveTurnRestartable(key);
      return 'ok';
    });
    const runner = buildMainTurnRunner({ agentId: agent.id, agent, conversation, broadcast: vi.fn(), runToken: token });
    await runner.runOneTurn({ userText: '在' });
    expect(duringTurn).toBe(false); // 本对话 delta 已打标
    await steeringQueue.handBackIfRunning(key, token);
  });

  it('chat.toolCall 同样算产出（审批卡/工具卡已可见，撤起必留痕）', async () => {
    const token = await occupyGate();
    let duringTurn = true;
    runChatMock.mockImplementation(async (args) => {
      args.emit({ type: 'chat.toolCall', conversationId: conversation.id, messageId: 'x' } as never);
      duringTurn = isLiveTurnRestartable(key);
      return 'ok';
    });
    const runner = buildMainTurnRunner({ agentId: agent.id, agent, conversation, broadcast: vi.fn(), runToken: token });
    await runner.runOneTurn({ userText: '在' });
    expect(duringTurn).toBe(false);
    await steeringQueue.handBackIfRunning(key, token);
  });
});

describe('装配层 origins 交接（S1 撤起链 custody）', () => {
  it('撤起链 custody 的 origins 进 turnInputs——回发随重起回合交付', async () => {
    // 模拟「回合1 消费了 om_1、被撤、新消息 om_2 过户」后的重起回合
    const token = await occupyGate();
    beginLiveTurn(key, token);
    noteLiveTurnOrigin(key, token, originOf('om_1'));
    supersedeLiveTurn(key, token, originOf('om_2'));
    const runner = buildMainTurnRunner({ agentId: agent.id, agent, conversation, broadcast: vi.fn(), runToken: token });
    await runner.runOneTurn({ userText: '吗', firstOrigin: originOf('om_2') });
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [turnInputs] = deliverMock.mock.calls[0];
    expect(turnInputs.map((i) => i.origin?.platformMessageId).sort()).toEqual(['om_1', 'om_2']);
    await steeringQueue.handBackIfRunning(key, token);
  });

  it('间隙插入（drain）的 origin 也入账 custody 与 turnInputs', async () => {
    const token = await occupyGate();
    // 回合在飞时再入队一条用户消息（走排队路径——探针默认读真登记表，此刻无条目判不可撤）
    await steeringQueue.enqueueOrStart(key, {
      clientMsgId: 'cm-drain',
      text: '插话',
      trigger: 'user',
      origin: originOf('om_drain'),
    });
    let drain: (() => Promise<string[]>) | undefined;
    turnArgsMock.mockImplementation((args) => {
      drain = args.drainSteering as unknown as typeof drain;
      return {
        emit: (ev: Parameters<typeof args.broadcast>[0]) => args.broadcast(ev),
        onAssistantPersisted: async () => {},
        drainSteering: args.drainSteering,
      } as unknown as ReturnType<typeof turnArgsMock>;
    });
    runChatMock.mockImplementation(async (args) => {
      const drained = await (args.drainSteering as unknown as () => Promise<string[]>)();
      expect(drained).toEqual(['插话']);
      await args.onAssistantPersisted?.({ text: '回复' } as Parameters<NonNullable<typeof args.onAssistantPersisted>>[0]);
      return 'ok';
    });
    const runner = buildMainTurnRunner({ agentId: agent.id, agent, conversation, broadcast: vi.fn(), runToken: token });
    await runner.runOneTurn({ userText: '在', firstOrigin: originOf('om_1') });
    expect(drain).toBeDefined();
    const [turnInputs] = deliverMock.mock.calls[0];
    expect(turnInputs.map((i) => i.origin?.platformMessageId).sort()).toEqual(['om_1', 'om_drain']);
    // 插话落盘（persistConsumed 单源）
    expect(appendMock).toHaveBeenCalledWith(agent.id, conversation.id, expect.objectContaining({ text: '插话' }));
    await steeringQueue.handBackIfRunning(key, token);
  });

  it('回合终了销条后 custody 清空——下一回合不继承旧 origins', async () => {
    const token = await occupyGate();
    const runner = buildMainTurnRunner({ agentId: agent.id, agent, conversation, broadcast: vi.fn(), runToken: token });
    await runner.runOneTurn({ userText: '在', firstOrigin: originOf('om_1') });
    // 第二回合（同 runner 续跑）：turnInputs 只含本回合新消费的
    await runner.runOneTurn({ userText: undefined, restartBatch: [
      { clientMsgId: 'cm-2', serverId: 's2', text: '吗', trigger: 'user', origin: originOf('om_2') },
    ] });
    const secondCall = deliverMock.mock.calls[1];
    expect(secondCall[0].map((i) => i.origin?.platformMessageId)).toEqual(['om_2']);
    await steeringQueue.handBackIfRunning(key, token);
  });
});

describe('装配层被撤回合的表情清理（S1 review · I1）', () => {
  it('custody 已过户（被撤起接替）→ aborted 收尾不抢清表情（归新回合清）', async () => {
    const token = await occupyGate();
    runChatMock.mockImplementation(async () => {
      // 回合在飞期间被撤起：custody 过户给新 token（abort 由入口编排做，这里只复现收尾时刻的状态）
      supersedeLiveTurn(key, token + 1);
      return 'aborted';
    });
    const runner = buildMainTurnRunner({ agentId: agent.id, agent, conversation, broadcast: vi.fn(), runToken: token });
    await runner.runOneTurn({ userText: '在', firstOrigin: originOf('om_1') });
    expect(clearItemsSpy).not.toHaveBeenCalled();
    drainLiveTurn(key); // custody 清场（防残留条目被下一用例 begin 继承）
    await steeringQueue.drainUnconsumedOnAbort(key); // 清场（闸还被旧 token 持着）
  });

  it('对照：无接替（Esc / 故障）→ aborted 收尾照常清表情（防永久悬挂）', async () => {
    const token = await occupyGate();
    runChatMock.mockResolvedValue('aborted');
    const runner = buildMainTurnRunner({ agentId: agent.id, agent, conversation, broadcast: vi.fn(), runToken: token });
    await runner.runOneTurn({ userText: '在', firstOrigin: originOf('om_1') });
    expect(clearItemsSpy).toHaveBeenCalledWith([{ origin: originOf('om_1') }]);
    await steeringQueue.drainUnconsumedOnAbort(key);
  });
});
