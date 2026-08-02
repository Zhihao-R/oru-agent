/**
 * chatStore·applyPendingTurnState（sleep-wake-chat-recovery）单测：
 *  - 半截接回：inflightPartial → messageId 对应消息补正文/工具调用；从未落盘则新建一条；
 *    并设置 streamingMessageIdByConv / pendingByConv（停止按钮可见、锁输入框）
 *  - 待答卡重建：pendingAsks 重新出现、disabled 复位为 false（睡眠前被置灰过也能续答）
 *  - running=false（外部真掐断）：卡重建但 disabled=true（不把「已中断」当可答）
 *  - 对账幂等：无在途内容时 apply 无副作用（不新增空消息、不误清其它对话卡）
 *  - 只影响目标对话的卡；其它对话的待答卡原样保留
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useChatStore } from '@/stores/chatStore';

const Q = (h: string) => ({ question: `${h}？`, header: h, options: [{ label: 'A' }] });

beforeEach(() => {
  useChatStore.setState({
    conversations: {},
    pendingByConv: {},
    streamingMessageIdByConv: {},
    lastSentByConv: {},
    draftTextByConv: {},
    pendingAsks: {},
    pendingBreaks: {},
    pendingHandbackByConv: {},
    error: null,
  });
});

describe('applyPendingTurnState·半截接回', () => {
  it('半截接到既有消息：补正文但不覆盖已有工具调用', () => {
    useChatStore.setState({
      conversations: {
        cnv_1: [{ id: 'msg_x', conversationId: 'cnv_1', role: 'assistant', text: '已落盘开头', toolCalls: [], createdAt: 1, done: true }],
      },
    });
    useChatStore.getState().applyPendingTurnState({
      conversationId: 'cnv_1',
      running: true,
      pendingAsks: [],
      inflightPartial: { messageId: 'msg_x', text: '半截续写', toolCalls: [{ id: 'tc1', name: 'bash', arguments: '{}' }] },
    });

    const list = useChatStore.getState().conversations.cnv_1;
    expect(list).toHaveLength(1);
    // 既有消息有正文 → 保留原文，不覆盖（半截 text 只在新建时空落）
    expect(list[0].text).toBe('已落盘开头');
    expect(list[0].toolCalls).toHaveLength(1);
    expect(list[0].done).toBe(false);
    // 停止按钮可见 + 锁输入框
    expect(useChatStore.getState().streamingMessageIdByConv.cnv_1).toBe('msg_x');
    expect(useChatStore.getState().pendingByConv.cnv_1).toBe(true);
  });

  it('半截从未落盘 → 新建一条并开 streaming', () => {
    useChatStore.getState().applyPendingTurnState({
      conversationId: 'cnv_2',
      running: true,
      pendingAsks: [],
      inflightPartial: { messageId: 'msg_new', text: '睡眠前的半截', toolCalls: [] },
    });
    const list = useChatStore.getState().conversations.cnv_2;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'msg_new', role: 'assistant', text: '睡眠前的半截', done: false });
    expect(useChatStore.getState().streamingMessageIdByConv.cnv_2).toBe('msg_new');
  });

  it('无 inflightPartial → 不新增空消息（对账幂等）', () => {
    useChatStore.getState().applyPendingTurnState({
      conversationId: 'cnv_3',
      running: true,
      pendingAsks: [],
      inflightPartial: null,
    });
    expect(useChatStore.getState().conversations.cnv_3 ?? []).toHaveLength(0);
  });
});

describe('applyPendingTurnState·待答卡重建', () => {
  it('pendingAsks 重新出现、disabled 复位为 false', () => {
    // 睡眠前该 conv 卡被置灰过（disabled）
    useChatStore.setState({
      pendingAsks: {
        ask_old: { askId: 'ask_old', conversationId: 'cnv_1', messageId: 'msg_x', questions: [Q('旧')], disabled: true },
      },
    });
    useChatStore.getState().applyPendingTurnState({
      conversationId: 'cnv_1',
      running: true,
      pendingAsks: [{ askId: 'ask_live', questions: [Q('新')] }],
      inflightPartial: { messageId: 'msg_x', text: '', toolCalls: [] },
    });
    const asks = useChatStore.getState().pendingAsks;
    // 旧卡被清掉，新卡按真相挂上并 disabled=false
    expect(asks.ask_old).toBeUndefined();
    expect(asks.ask_live).toBeDefined();
    expect(asks.ask_live?.disabled).toBe(false);
    expect(asks.ask_live?.questions).toEqual([Q('新')]);
  });

  it('running=false（真中断）→ 卡重建但 disabled=true', () => {
    useChatStore.getState().applyPendingTurnState({
      conversationId: 'cnv_1',
      running: false,
      pendingAsks: [{ askId: 'ask_int', questions: [Q('断')] }],
      inflightPartial: null,
    });
    expect(useChatStore.getState().pendingAsks.ask_int?.disabled).toBe(true);
  });

  it('running=false 不锁输入框（中断场景应可发新消息）', () => {
    useChatStore.setState({ pendingByConv: { cnv_1: false } });
    useChatStore.getState().applyPendingTurnState({
      conversationId: 'cnv_1',
      running: false,
      pendingAsks: [],
      inflightPartial: { messageId: 'msg_int', text: '中断前的半截', toolCalls: [] },
    });
    // 中断分支：半截接回显示，但不设 streaming 标志、不锁输入框
    expect(useChatStore.getState().pendingByConv.cnv_1).toBe(false);
    expect(useChatStore.getState().streamingMessageIdByConv.cnv_1).toBeNull();
    expect(useChatStore.getState().conversations.cnv_1[0].text).toBe('中断前的半截');
  });

  it('只影响目标对话的卡，其它对话的卡原样保留', () => {
    useChatStore.setState({
      pendingAsks: {
        ask_other: { askId: 'ask_other', conversationId: 'cnv_9', messageId: 'm9', questions: [Q('他')], disabled: false },
      },
    });
    useChatStore.getState().applyPendingTurnState({
      conversationId: 'cnv_1',
      running: true,
      pendingAsks: [{ askId: 'ask_1', questions: [Q('本')] }],
      inflightPartial: null,
    });
    const asks = useChatStore.getState().pendingAsks;
    expect(asks.ask_other).toBeDefined(); // 别的对话不受影响
    expect(asks.ask_1).toBeDefined();
  });
});
