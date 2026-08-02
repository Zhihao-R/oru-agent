/**
 * #6 chatStore steering「将生效」生命周期——纯前端状态机（发送/入队回执/读入/撤回/中断退回）。
 *
 * 断言的是服务端事件 / 回执 → 主对话流气泡状态的迁移，不押 UI 渲染。
 * send() 依赖 ws/agentStore/conversationStore，下面 seed 齐三者。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentStore } from '@/stores/agentStore';
import type { ChatMessage, Conversation } from '@shared/types';

const CONV = 'cnv_s';
const AGENT = 'agt_s';

function seedStores(): void {
  const conv: Conversation = {
    id: CONV,
    ownerId: 'local-user',
    agentId: AGENT,
    kind: 'main',
    title: '',
    sdkSessionId: null,
    createdAt: 0,
    updatedAt: 0,
  };
  useConversationStore.setState({ byId: { [CONV]: conv }, activeByAgent: { [AGENT]: CONV } });
  useAgentStore.setState({ activeAgentId: AGENT });
}

function list(): ChatMessage[] {
  return useChatStore.getState().conversations[CONV] ?? [];
}

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ type: 'ack' });
  useConversationStore.setState({ byId: {}, activeByAgent: {} });
  useAgentStore.setState({ activeAgentId: null });
  useChatStore.setState({
    conversations: {},
    pendingByConv: {},
    streamingMessageIdByConv: {},
    lastSentByConv: {},
    draftTextByConv: {},
    error: null,
  });
});

// ─── send：忙时将生效 / 空闲普通 ───────────────────────────────

describe('send 带 clientMsgId + 排队标记单源来自 added 广播', () => {
  it('空闲发送：普通气泡（无 steering）、chat.send 带 clientMsgId', async () => {
    seedStores();
    await useChatStore.getState().send('改个标题');
    const msgs = list();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].steering).toBeUndefined();
    expect(msgs[0].clientMsgId).toBeTruthy();
    const sent = requestMock.mock.calls[0][0] as { type: string; clientMsgId?: string };
    expect(sent.type).toBe('chat.send');
    expect(sent.clientMsgId).toBe(msgs[0].clientMsgId);
  });

  it('忙时发送：乐观气泡不做本地排队预测（steering undefined）', async () => {
    // 缺陷回归：旧的 wasBusy 预测在「忙碌误判 + 实际起回合」时画出会撒谎的「排队中」标记。
    // 排队与否只有服务端知道——本地一律不预测，标记等 added 广播。
    seedStores();
    useChatStore.setState({ pendingByConv: { [CONV]: true } });
    await useChatStore.getState().send('顺便配色也调一下');
    const msgs = list();
    expect(msgs).toHaveLength(1);
    expect(msgs[0].steering).toBeUndefined();
  });

  it('忙时发送 → chat.steering.added 到达：气泡补上排队标记并对齐 serverId', async () => {
    seedStores();
    useChatStore.setState({ pendingByConv: { [CONV]: true } });
    await useChatStore.getState().send('顺便配色也调一下');
    const clientMsgId = list()[0].clientMsgId!;
    useChatStore.getState().handleSteeringAdded({
      type: 'chat.steering.added',
      conversationId: CONV,
      clientMsgId,
      serverId: 's1',
    });
    expect(list()[0].steering).toEqual({ state: 'queued', serverId: 's1' });
  });
});

// ─── added / consumed ─────────────────────────────────────────

describe('入队回执与边界读入', () => {
  it('handleSteeringAdded 把乐观气泡对齐 serverId', () => {
    seedStores();
    useChatStore.setState({
      conversations: {
        [CONV]: [mkSteeringMsg('c1', { state: 'queued' })],
      },
    });
    useChatStore.getState().handleSteeringAdded({
      type: 'chat.steering.added',
      conversationId: CONV,
      clientMsgId: 'c1',
      serverId: 's1',
    });
    expect(list()[0].steering).toEqual({ state: 'queued', serverId: 's1' });
  });

  it('handleSteeringConsumed 按 serverId 清 steering，落定为普通消息', () => {
    seedStores();
    useChatStore.setState({
      conversations: {
        [CONV]: [
          mkSteeringMsg('c1', { state: 'queued', serverId: 's1' }),
          mkSteeringMsg('c2', { state: 'queued', serverId: 's2' }),
        ],
      },
    });
    useChatStore.getState().handleSteeringConsumed({
      type: 'chat.steering.consumed',
      conversationId: CONV,
      serverIds: ['s1'],
    });
    expect(list()[0].steering).toBeUndefined(); // 读入 → 普通
    expect(list()[1].steering).toEqual({ state: 'queued', serverId: 's2' }); // 未读入仍将生效
  });
});

// ─── withdraw：撤回中 → removed / alreadyConsumed ──────────────

describe('撤回（不可逆删的禁令：乐观置撤回中，删/落定等回执）', () => {
  it('removed：先置「撤回中」、回执后移除气泡', async () => {
    seedStores();
    useChatStore.setState({
      conversations: { [CONV]: [mkSteeringMsg('c1', { state: 'queued', serverId: 's1' })] },
    });
    requestMock.mockResolvedValue({
      type: 'chat.steering.withdrawResult',
      conversationId: CONV,
      clientMsgId: 'c1',
      result: 'removed',
    });
    await useChatStore.getState().withdrawSteering(CONV, 'c1');
    expect(list()).toHaveLength(0);
    const sent = requestMock.mock.calls[0][0] as { type: string };
    expect(sent.type).toBe('chat.steering.withdraw');
  });

  it('alreadyConsumed：撤回晚于读入 → 气泡落定为已读入普通消息（不删、不闪烁）', async () => {
    seedStores();
    useChatStore.setState({
      conversations: { [CONV]: [mkSteeringMsg('c1', { state: 'queued', serverId: 's1' })] },
    });
    requestMock.mockResolvedValue({
      type: 'chat.steering.withdrawResult',
      conversationId: CONV,
      clientMsgId: 'c1',
      result: 'alreadyConsumed',
    });
    await useChatStore.getState().withdrawSteering(CONV, 'c1');
    expect(list()).toHaveLength(1);
    expect(list()[0].steering).toBeUndefined();
  });

  it('ws 失败：从「撤回中」回退为可撤回 pending（绝不静默删）', async () => {
    seedStores();
    useChatStore.setState({
      conversations: { [CONV]: [mkSteeringMsg('c1', { state: 'queued', serverId: 's1' })] },
    });
    requestMock.mockRejectedValue(new Error('ws down'));
    await useChatStore.getState().withdrawSteering(CONV, 'c1');
    expect(list()[0].steering).toEqual({ state: 'queued', serverId: 's1' });
  });
});

// ─── abort：未消费退回草稿 + 移除将生效气泡 ────────────────────

describe('中断（Esc）退回未消费', () => {
  it('abortResult.unconsumed 拼到草稿「前」（不覆盖已有草稿）+ 移除将生效气泡', async () => {
    seedStores();
    useChatStore.setState({
      conversations: {
        [CONV]: [
          mkNormalMsg('已读入的'), // 普通消息（已消费）——不该被移除
          mkSteeringMsg('c1', { state: 'queued', serverId: 's1' }),
        ],
      },
      streamingMessageIdByConv: { [CONV]: 'asst_1' },
      draftTextByConv: { [CONV]: '我打了一半的字' },
    });
    // abort 守卫：streamingMessageId 必须存在；conv 已 seed
    requestMock.mockResolvedValue({
      type: 'chat.abortResult',
      conversationId: CONV,
      // 桌面用户亲手打的字（trigger:'user' 无 origin）→ handbackForm 判 'draft' → 回填草稿
      items: [
        { serverId: 'x1', clientMsgId: 'x1', text: '顺便配色', trigger: 'user' },
        { serverId: 'x2', clientMsgId: 'x2', text: '字体也换', trigger: 'user' },
      ],
    });
    await useChatStore.getState().abort(CONV);
    // 未消费拼在草稿前、原草稿保留在后
    expect(useChatStore.getState().draftTextByConv[CONV]).toBe('顺便配色\n字体也换\n我打了一半的字');
    // 将生效气泡移除，普通消息留存
    const msgs = list();
    expect(msgs.some((m) => m.steering)).toBe(false);
    expect(msgs.some((m) => m.text === '已读入的')).toBe(true);
  });

  it('回归：撤回中（withdrawing）气泡 abort 不删——等 withdrawResult 回执处置，不违反不可逆删禁令', async () => {
    seedStores();
    useChatStore.setState({
      conversations: {
        [CONV]: [
          mkSteeringMsg('cw', { state: 'withdrawing', serverId: 'sw' }), // 撤回飞出、回执未到
          mkSteeringMsg('cq', { state: 'queued', serverId: 'sq' }), // 普通将生效
        ],
      },
      streamingMessageIdByConv: { [CONV]: 'asst_1' },
      draftTextByConv: { [CONV]: '' },
    });
    // 撤回先到服务端出队 → abort 的 items 不含 cw（只含还在队列的 cq）
    requestMock.mockResolvedValue({
      type: 'chat.abortResult',
      conversationId: CONV,
      items: [{ serverId: 'sq', clientMsgId: 'cq', text: '将生效 cq', trigger: 'user' }],
    });
    await useChatStore.getState().abort(CONV);
    const msgs = list();
    // 撤回中的气泡留存（等 withdrawResult 裁决）；queued 的被退回移除
    expect(msgs.find((m) => m.clientMsgId === 'cw')?.steering?.state).toBe('withdrawing');
    expect(msgs.find((m) => m.clientMsgId === 'cq')).toBeUndefined();
    expect(useChatStore.getState().draftTextByConv[CONV]).toBe('将生效 cq');
  });

  it('无未消费时：草稿与气泡不动（普通停止零副作用）', async () => {
    seedStores();
    useChatStore.setState({
      conversations: { [CONV]: [mkNormalMsg('hi')] },
      streamingMessageIdByConv: { [CONV]: 'asst_1' },
      draftTextByConv: { [CONV]: '草稿' },
    });
    requestMock.mockResolvedValue({
      type: 'chat.abortResult',
      conversationId: CONV,
      items: [],
    });
    await useChatStore.getState().abort(CONV);
    expect(useChatStore.getState().draftTextByConv[CONV]).toBe('草稿');
    expect(list()).toHaveLength(1);
  });
});

// ─── applyHandback：交还清除排队气泡 ──────────────────────────

describe('队列交还（applyHandback）清除排队气泡', () => {
  it('交还项按 serverId 移除对应气泡 + 文本回填草稿（缺陷回归：留下的僵尸气泡点撤回会撒谎）', () => {
    seedStores();
    useChatStore.setState({
      conversations: {
        [CONV]: [
          mkNormalMsg('已读入的'),
          mkSteeringMsg('c1', { state: 'queued', serverId: 's1' }),
        ],
      },
      draftTextByConv: { [CONV]: '' },
    });
    useChatStore
      .getState()
      .applyHandback(CONV, [{ serverId: 's1', clientMsgId: 'c1', text: '将生效 c1', trigger: 'user' }]);
    const msgs = list();
    expect(msgs.find((m) => m.clientMsgId === 'c1')).toBeUndefined();
    expect(msgs.some((m) => m.text === '已读入的')).toBe(true);
    expect(useChatStore.getState().draftTextByConv[CONV]).toBe('将生效 c1');
  });

  it('不变量守护：withdrawing 气泡不删——等 withdrawResult 回执处置', () => {
    seedStores();
    useChatStore.setState({
      conversations: { [CONV]: [mkSteeringMsg('cw', { state: 'withdrawing', serverId: 'sw' })] },
      draftTextByConv: { [CONV]: '' },
    });
    useChatStore
      .getState()
      .applyHandback(CONV, [{ serverId: 'sw', clientMsgId: 'cw', text: '将生效 cw', trigger: 'user' }]);
    expect(list().find((m) => m.clientMsgId === 'cw')?.steering?.state).toBe('withdrawing');
  });
});

// ─── helpers ──────────────────────────────────────────────────

function mkSteeringMsg(clientMsgId: string, steering: ChatMessage['steering']): ChatMessage {
  return {
    id: `local_${clientMsgId}`,
    conversationId: CONV,
    role: 'user',
    text: `将生效 ${clientMsgId}`,
    toolCalls: [],
    createdAt: 0,
    done: true,
    clientMsgId,
    steering,
  };
}

function mkNormalMsg(text: string): ChatMessage {
  return {
    id: `n_${text}`,
    conversationId: CONV,
    role: 'user',
    text,
    toolCalls: [],
    createdAt: 0,
    done: true,
  };
}
