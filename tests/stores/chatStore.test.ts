/**
 * chatStore 合约测试
 *
 * 测的是"WS 事件 → 主对话流"的纯状态机。
 * 不测 send()（依赖 ws/agentStore/conversationStore，是集成测试）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: { request: (...args: unknown[]) => requestMock(...args) },
}));

import { attachNetworkErrorToLast, useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import type { ChatMessage, Conversation } from '@shared/types';

const CONV = 'cnv_test';
const MID = 'msg_1';
const AGENT = 'agt_1';

/** 把 conv 注册进 conversationStore.byId，否则 abort() 在 `if (!conv) return` 处提前退出 */
function seedConv(): void {
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
  useConversationStore.setState({ byId: { [CONV]: conv } });
}

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ type: 'ack' });
  useConversationStore.setState({ byId: {} });
  useChatStore.setState({
    conversations: {},
    pendingByConv: {},
    streamingMessageIdByConv: {},
    lastSentByConv: {},
    draftTextByConv: {},
    error: null,
  });
});

describe('startAssistantMessage', () => {
  it('为 conversation 建桶并放入空 assistant 消息', () => {
    useChatStore.getState().startAssistantMessage(CONV, MID);
    const list = useChatStore.getState().conversations[CONV];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: MID, role: 'assistant', text: '', done: false });
  });

  it('同 messageId 重复 start 是幂等的', () => {
    const s = useChatStore.getState();
    s.startAssistantMessage(CONV, MID);
    s.startAssistantMessage(CONV, MID);
    expect(useChatStore.getState().conversations[CONV]).toHaveLength(1);
  });

  // 回归：后端自发起的回合（maybeResumeTurn 续跑 / idle 播报）不走 send()。chat.started 必须
  // 同时建立两件事——streamingMessageId（abort 目标 + 中止权威）和 pending（锁输入框）。
  // 缺前者则这类回合停不掉，缺后者则流式中输入框不锁。abort 实际能否生效见下方 abort describe。
  it('后端发起的流（无 send）也建立 streamingMessageId 与 pendingByConv', () => {
    expect(useChatStore.getState().streamingMessageIdByConv[CONV]).toBeUndefined();
    expect(useChatStore.getState().pendingByConv[CONV]).toBeUndefined();
    useChatStore.getState().startAssistantMessage(CONV, MID);
    expect(useChatStore.getState().streamingMessageIdByConv[CONV]).toBe(MID);
    expect(useChatStore.getState().pendingByConv[CONV]).toBe(true);
  });
});

describe('appendDelta（流式累加）', () => {
  it('多次 delta 累加成完整文本', () => {
    const s = useChatStore.getState();
    s.appendDelta(CONV, MID, { textChunk: 'Hello, ' });
    s.appendDelta(CONV, MID, { textChunk: 'world' });
    s.appendDelta(CONV, MID, { textChunk: '!' });
    const msg = useChatStore.getState().conversations[CONV][0];
    expect(msg.text).toBe('Hello, world!');
  });

  it('delta 在没显式 startAssistantMessage 时自动建消息', () => {
    useChatStore.getState().appendDelta(CONV, MID, { textChunk: 'x' });
    const msg = useChatStore.getState().conversations[CONV][0];
    expect(msg.text).toBe('x');
    expect(msg.role).toBe('assistant');
  });

  it('空 textChunk 不修改 text', () => {
    const s = useChatStore.getState();
    s.appendDelta(CONV, MID, { textChunk: 'a' });
    s.appendDelta(CONV, MID, {});
    expect(useChatStore.getState().conversations[CONV][0].text).toBe('a');
  });
});

describe('toolCalls', () => {
  it('addToolCall 追加到对应 message', () => {
    const s = useChatStore.getState();
    s.startAssistantMessage(CONV, MID);
    s.addToolCall(CONV, MID, {
      id: 'tc1',
      name: 'Read',
      input: { path: '/x' },
      status: 'running',
      startedAt: 1000,
    });
    const msg = useChatStore.getState().conversations[CONV][0];
    expect(msg.toolCalls.map((t) => t.id)).toEqual(['tc1']);
  });

  it('同 id 二次 addToolCall 替换（不重复）', () => {
    const s = useChatStore.getState();
    s.addToolCall(CONV, MID, {
      id: 'tc1',
      name: 'Read',
      input: { path: '/x' },
      status: 'running',
      startedAt: 1000,
    });
    s.addToolCall(CONV, MID, {
      id: 'tc1',
      name: 'Read',
      input: { path: '/x' },
      status: 'success',
      startedAt: 1000,
    });
    const msg = useChatStore.getState().conversations[CONV][0];
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls[0].status).toBe('success');
  });

  it('updateToolResult 把 status 从 running 改成 success', () => {
    const s = useChatStore.getState();
    s.addToolCall(CONV, MID, {
      id: 'tc1',
      name: 'Read',
      input: {},
      status: 'running',
      startedAt: 1000,
    });
    s.updateToolResult(CONV, MID, {
      toolCallId: 'tc1',
      isError: false,
      summary: 'ok',
      detail: 'full',
    });
    const tc = useChatStore.getState().conversations[CONV][0].toolCalls[0];
    expect(tc.status).toBe('success');
    expect(tc.result?.summary).toBe('ok');
  });

  it('updateToolResult 在 isError=true 时设 status=error', () => {
    const s = useChatStore.getState();
    s.addToolCall(CONV, MID, {
      id: 'tc1',
      name: 'Read',
      input: {},
      status: 'running',
      startedAt: 1000,
    });
    s.updateToolResult(CONV, MID, {
      toolCallId: 'tc1',
      isError: true,
      summary: 'bad',
    });
    expect(useChatStore.getState().conversations[CONV][0].toolCalls[0].status).toBe('error');
  });

  it('updateToolResult 找不到 messageId 是 no-op', () => {
    useChatStore.getState().updateToolResult('cnv_x', 'msg_x', {
      toolCallId: 'tc1',
      isError: false,
      summary: '',
    });
    expect(useChatStore.getState().conversations['cnv_x']).toBeUndefined();
  });
});

describe('markDone', () => {
  it('标记消息完成 + 清 pendingByConv', () => {
    const s = useChatStore.getState();
    useChatStore.setState({ pendingByConv: { [CONV]: true } });
    s.startAssistantMessage(CONV, MID);
    s.markDone(CONV, MID);
    expect(useChatStore.getState().conversations[CONV][0].done).toBe(true);
    expect(useChatStore.getState().pendingByConv[CONV]).toBe(false);
  });

  it('找不到消息也会清该 conv 的 pending（保险）', () => {
    useChatStore.setState({ pendingByConv: { cnv_x: true } });
    useChatStore.getState().markDone('cnv_x', 'ghost');
    expect(useChatStore.getState().pendingByConv['cnv_x']).toBe(false);
  });
});

describe('attachNetworkErrorToLast', () => {
  const mkMsg = (overrides: Partial<ChatMessage>): ChatMessage => ({
    id: 'm',
    conversationId: CONV,
    role: 'user',
    text: '',
    toolCalls: [],
    createdAt: 0,
    done: true,
    ...overrides,
  });

  it('末条是 assistant 时，error 写到该 assistant 自身（不追加）', () => {
    const conversations = {
      [CONV]: [mkMsg({ role: 'assistant', id: 'a1' })],
    };
    const next = attachNetworkErrorToLast(conversations, CONV, 'network down');
    expect(next[CONV]).toHaveLength(1);
    expect(next[CONV][0].id).toBe('a1');
    expect(next[CONV][0].error).toEqual({ message: 'network down', retryable: true });
  });

  it('末条是 user 时，追加一条 errored assistant placeholder', () => {
    const conversations = {
      [CONV]: [mkMsg({ role: 'user', id: 'u1', text: 'hi' })],
    };
    const next = attachNetworkErrorToLast(conversations, CONV, 'send failed');
    expect(next[CONV]).toHaveLength(2);
    expect(next[CONV][0].id).toBe('u1');
    expect(next[CONV][0].error).toBeUndefined();
    expect(next[CONV][1].role).toBe('assistant');
    expect(next[CONV][1].error).toEqual({ message: 'send failed', retryable: true });
    expect(next[CONV][1].done).toBe(true);
  });

  it('末条是非 assistant 卡片（memory-record / context-compressed）时，也追加 placeholder', () => {
    const conversations = {
      [CONV]: [mkMsg({ role: 'system', id: 'card', kind: 'memory-record' })],
    };
    const next = attachNetworkErrorToLast(conversations, CONV, 'oops');
    expect(next[CONV]).toHaveLength(2);
    expect(next[CONV][1].role).toBe('assistant');
    expect(next[CONV][1].error).toEqual({ message: 'oops', retryable: true });
  });

  it('空 bucket 时也追加 placeholder（不静默丢错）', () => {
    const next = attachNetworkErrorToLast({}, CONV, 'first error');
    expect(next[CONV]).toHaveLength(1);
    expect(next[CONV][0].role).toBe('assistant');
    expect(next[CONV][0].error?.message).toBe('first error');
  });

  it('不影响其他 conv 的 bucket', () => {
    const other = mkMsg({ id: 'other', conversationId: 'cnv_other' });
    const conversations = {
      [CONV]: [mkMsg({ role: 'user', id: 'u1' })],
      cnv_other: [other],
    };
    const next = attachNetworkErrorToLast(conversations, CONV, 'x');
    expect(next.cnv_other).toEqual([other]); // 完全没动 B
  });
});

describe('按 conv 分桶不串味', () => {
  const A = 'cnv_a';
  const B = 'cnv_b';

  it('A markDone 不影响 B 的 pending', () => {
    const s = useChatStore.getState();
    useChatStore.setState({ pendingByConv: { [A]: true, [B]: true } });
    s.startAssistantMessage(A, 'ma');
    s.markDone(A, 'ma');
    const st = useChatStore.getState();
    expect(st.pendingByConv[A]).toBe(false);
    expect(st.pendingByConv[B]).toBe(true);
  });

  it('A markDone 不动 B 的 streamingMessageId', () => {
    const s = useChatStore.getState();
    s.startAssistantMessage(A, 'ma');
    s.startAssistantMessage(B, 'mb');
    s.markDone(A, 'ma');
    const st = useChatStore.getState();
    expect(st.streamingMessageIdByConv[A]).toBeNull();
    expect(st.streamingMessageIdByConv[B]).toBe('mb');
  });

  it('markDone 的 streamingMessageId 比较必须按 conv——A 老消息的 done 事件不能清 B 的 streaming', () => {
    const s = useChatStore.getState();
    // 模拟 A 上轮已结束但还没收到 done 事件、B 新轮已开始的竞态
    useChatStore.setState({
      streamingMessageIdByConv: { [A]: 'a_old', [B]: 'b_new' },
    });
    s.markDone(A, 'a_old');
    const st = useChatStore.getState();
    expect(st.streamingMessageIdByConv[A]).toBeNull();
    expect(st.streamingMessageIdByConv[B]).toBe('b_new');
  });

  it('setDraftText 按 conv 写入互不覆盖', () => {
    const s = useChatStore.getState();
    s.setDraftText(A, 'draft for A');
    s.setDraftText(B, 'draft for B');
    const st = useChatStore.getState();
    expect(st.draftTextByConv[A]).toBe('draft for A');
    expect(st.draftTextByConv[B]).toBe('draft for B');
  });

  it('缺 key 时各分桶字段读时按空值返回', () => {
    const st = useChatStore.getState();
    expect(st.pendingByConv['missing']).toBeUndefined();
    expect(st.streamingMessageIdByConv['missing']).toBeUndefined();
    expect(st.draftTextByConv['missing']).toBeUndefined();
    expect(st.lastSentByConv['missing']).toBeUndefined();
  });
});

describe('appendUserMessage', () => {
  it('返回 user 消息并写入桶', () => {
    const m = useChatStore.getState().appendUserMessage(CONV, '  hi  ');
    expect(m.role).toBe('user');
    expect(m.text).toBe('  hi  '); // 不裁剪——裁剪由 send() 做
    expect(useChatStore.getState().conversations[CONV]).toHaveLength(1);
  });
});

describe('loadHistory', () => {
  it('整个替换桶（用于 conv.history.result）', () => {
    const s = useChatStore.getState();
    s.appendUserMessage(CONV, 'lost');
    const history: ChatMessage[] = [
      {
        id: 'm1',
        conversationId: CONV,
        role: 'user',
        text: 'a',
        toolCalls: [],
        createdAt: 100,
        done: true,
      },
      {
        id: 'm2',
        conversationId: CONV,
        role: 'assistant',
        text: 'b',
        toolCalls: [],
        createdAt: 200,
        done: true,
      },
    ];
    s.loadHistory(CONV, history);
    expect(useChatStore.getState().conversations[CONV].map((m) => m.id)).toEqual(['m1', 'm2']);
  });
});

describe('reconcileBusyState（卡死 pending 对账：末条终态 = 回合已结束）', () => {
  // 回归：chat.done 在断连/中断中丢失 → pendingByConv 卡 true，但末条已是终态 assistant。
  // 复盘见 bug：retry 静默早退 + 重发误入 steering「将生效」，二者都源于读这卡死标志。
  const mk = (o: Partial<ChatMessage>): ChatMessage => ({
    id: 'm', conversationId: CONV, role: 'assistant', text: '', toolCalls: [], createdAt: 0, done: false, ...o,
  });
  const user = mk({ id: 'u1', role: 'user', text: 'hi', done: true });

  it('末条是用户主动中断的 assistant（aborted 终态）→ 清 pending 与 streamingMessageId', () => {
    useChatStore.setState({
      conversations: { [CONV]: [user, mk({ id: 'a1', abortedByUser: true })] },
      pendingByConv: { [CONV]: true },
      streamingMessageIdByConv: { [CONV]: 'a1' },
    });
    useChatStore.getState().reconcileBusyState(CONV);
    const st = useChatStore.getState();
    expect(st.pendingByConv[CONV]).toBe(false);
    expect(st.streamingMessageIdByConv[CONV]).toBeNull();
  });

  it('末条是报错的 assistant（errored 也是终态，handleChatError 不清 pending）→ 清 pending', () => {
    useChatStore.setState({
      conversations: { [CONV]: [user, mk({ id: 'a1', error: { message: 'network down', retryable: true } })] },
      pendingByConv: { [CONV]: true },
      streamingMessageIdByConv: { [CONV]: 'a1' },
    });
    useChatStore.getState().reconcileBusyState(CONV);
    const st = useChatStore.getState();
    expect(st.pendingByConv[CONV]).toBe(false);
    expect(st.streamingMessageIdByConv[CONV]).toBeNull();
  });

  it('末条是刚发的 user 消息（回合真在途，尚无 assistant）→ 不动 pending', () => {
    useChatStore.setState({
      conversations: { [CONV]: [user] },
      pendingByConv: { [CONV]: true },
      streamingMessageIdByConv: { [CONV]: null },
    });
    useChatStore.getState().reconcileBusyState(CONV);
    expect(useChatStore.getState().pendingByConv[CONV]).toBe(true);
  });

  it('末条是进行中的 assistant（无终态标记）→ 不动 pending', () => {
    useChatStore.setState({
      conversations: { [CONV]: [mk({ id: 'a1', text: '正在输出…' })] },
      pendingByConv: { [CONV]: true },
      streamingMessageIdByConv: { [CONV]: 'a1' },
    });
    useChatStore.getState().reconcileBusyState(CONV);
    expect(useChatStore.getState().pendingByConv[CONV]).toBe(true);
  });

  // ─── 判据升级回归：跳过非当前回合产物后取末条（lastTurnTerminusCandidate）───

  it('末条是 memory-record 卡、其前是终态 assistant → 卡不遮蔽终态，清 pending（缺陷回归）', () => {
    useChatStore.setState({
      conversations: {
        [CONV]: [
          user,
          mk({ id: 'a1', done: true, text: '回复完了' }),
          // 真实形状：卡片 role:'system'（turnArgs.ts）——旧判据在这里 bail、pending 卡死
          mk({ id: 'c1', role: 'system', kind: 'memory-record', done: true }),
        ],
      },
      pendingByConv: { [CONV]: true },
      streamingMessageIdByConv: { [CONV]: null },
    });
    useChatStore.getState().reconcileBusyState(CONV);
    expect(useChatStore.getState().pendingByConv[CONV]).toBe(false);
  });

  it('末条是刚发的 user、其前是上一轮终态 assistant → user 挡住回溯，不动 pending（防误清窗口）', () => {
    // send() 在 appendUserMessage 之前调 reconcileBusyState；若 user 不在白名单会跳过它
    // 找到上一轮终态 assistant 而误清。user 必须有资格作候选、且判定为「非终态」。
    useChatStore.setState({
      conversations: {
        [CONV]: [mk({ id: 'a0', done: true, text: '上一轮回复' }), mk({ id: 'u2', role: 'user', text: '新消息', done: true })],
      },
      pendingByConv: { [CONV]: true },
      streamingMessageIdByConv: { [CONV]: null },
    });
    useChatStore.getState().reconcileBusyState(CONV);
    expect(useChatStore.getState().pendingByConv[CONV]).toBe(true);
  });

  it('末条是 scheduled-run-output（done:true）、其前是进行中 assistant → 后台产出不算当前回合终态，不动 pending', () => {
    useChatStore.setState({
      conversations: {
        [CONV]: [
          mk({ id: 'a1', text: '正在输出…' }),
          mk({ id: 's1', kind: 'scheduled-run-output', done: true, text: '定时任务产出' }),
        ],
      },
      pendingByConv: { [CONV]: true },
      streamingMessageIdByConv: { [CONV]: 'a1' },
    });
    useChatStore.getState().reconcileBusyState(CONV);
    expect(useChatStore.getState().pendingByConv[CONV]).toBe(true);
  });

  it('末条是 git-hint 卡、其前是刚发的 user → 不动 pending', () => {
    useChatStore.setState({
      conversations: { [CONV]: [user, mk({ id: 'g1', role: 'system', kind: 'git-hint', done: true })] },
      pendingByConv: { [CONV]: true },
      streamingMessageIdByConv: { [CONV]: null },
    });
    useChatStore.getState().reconcileBusyState(CONV);
    expect(useChatStore.getState().pendingByConv[CONV]).toBe(true);
  });
});

describe('retryLast（卡死 pending 不再吞掉重试）', () => {
  it('pending 卡 true + 末条是空半截按停的 assistant + 有 lastSent → 重试不被吞、走 chat.resume', async () => {
    seedConv();
    useChatStore.setState({
      conversations: {
        [CONV]: [
          { id: 'u1', conversationId: CONV, role: 'user', text: '那我应该按什么思路扩张？', toolCalls: [], createdAt: 100, done: true },
          { id: 'a1', conversationId: CONV, role: 'assistant', text: '', toolCalls: [], createdAt: 200, done: false, abortedByUser: true },
        ],
      },
      pendingByConv: { [CONV]: true }, // ← 卡死：断连丢了 chat.done
      lastSentByConv: { [CONV]: { text: '那我应该按什么思路扩张？', attachments: null } },
    });
    await useChatStore.getState().retryLast(CONV);
    // 本用例的主张 = 卡死 pending 不再吞掉重试：修复前第一行 `if (pendingByConv) return` 直接吞掉，
    // requestMock 0 次调用（=点重试没反应）。reconcileBusyState 先据末条终态清诚实，重试才发得出。
    expect(requestMock).toHaveBeenCalledTimes(1);
    // 空半截按停（abortedByUser）= 已中断可续，走 chat.resume 就地重生成，不重发 user（不制造重复历史）。
    expect(requestMock.mock.calls[0][0]).toMatchObject({ type: 'chat.resume', conversationId: CONV });
  });
});

describe('event sequence: 一轮典型对话', () => {
  it('user → start → 多次 delta → tool call → tool result → done', () => {
    const s = useChatStore.getState();
    // 用户发言
    s.appendUserMessage(CONV, '帮我看下 README');
    // 服务端 chat.started
    s.startAssistantMessage(CONV, MID);
    // 流式文本
    s.appendDelta(CONV, MID, { textChunk: '我' });
    s.appendDelta(CONV, MID, { textChunk: '看' });
    s.appendDelta(CONV, MID, { textChunk: '一下。' });
    // 工具调用
    s.addToolCall(CONV, MID, {
      id: 'tc1',
      name: 'Read',
      input: { path: 'README.md' },
      status: 'running',
      startedAt: 100,
    });
    s.updateToolResult(CONV, MID, {
      toolCallId: 'tc1',
      isError: false,
      summary: '# Title...',
    });
    // 完成
    s.markDone(CONV, MID);

    const list = useChatStore.getState().conversations[CONV];
    expect(list).toHaveLength(2);
    expect(list[0].role).toBe('user');
    expect(list[1].role).toBe('assistant');
    expect(list[1].text).toBe('我看一下。');
    expect(list[1].toolCalls).toHaveLength(1);
    expect(list[1].toolCalls[0].status).toBe('success');
    expect(list[1].done).toBe(true);
    expect(useChatStore.getState().pendingByConv[CONV]).toBe(false);
  });
});

describe('abort（中止守卫 = 后端流是否还开着，而非 pendingByConv）', () => {
  it('后端发起的回合（startAssistantMessage，无 send）可被中止：发 chat.abort + 乐观变灰', async () => {
    seedConv();
    // 模拟后端广播 chat.started——这是后端自发起回合（maybeResumeTurn / idle）的入口，
    // 全程没走过 send()。
    useChatStore.getState().startAssistantMessage(CONV, MID);

    await useChatStore.getState().abort(CONV);

    expect(requestMock).toHaveBeenCalledWith({
      type: 'chat.abort',
      agentId: AGENT,
      conversationId: CONV,
    });
    const msg = useChatStore.getState().conversations[CONV][0];
    expect(msg.abortedByUser).toBe(true);
  });

  // 收敛核心回归：守卫读 streamingMessageId，不读 pendingByConv。
  // 显式把 pending 置 false，证明 abort 仍生效——杜绝"借 pending 当中止守卫"的旧病根复发。
  it('streamingMessageId 在、pendingByConv=false 时仍能中止', async () => {
    seedConv();
    useChatStore.getState().startAssistantMessage(CONV, MID);
    useChatStore.setState({ pendingByConv: { [CONV]: false } });

    await useChatStore.getState().abort(CONV);

    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().conversations[CONV][0].abortedByUser).toBe(true);
  });

  it('没有进行中的流（streamingMessageId 为空）→ 中止是 no-op，不发 IPC', async () => {
    seedConv();
    // 没有 startAssistantMessage：streamingMessageIdByConv 为空
    await useChatStore.getState().abort(CONV);
    expect(requestMock).not.toHaveBeenCalled();
  });
});
