/**
 * useCommentChatRouter · chat.taskReport 分支回归（taskReport 误 revoke 图片 bug）
 *
 * 老 bug：taskReport 用 loadHistory([...list, m]) 追加单条消息——loadHistory 会 revoke
 * 旧列表所有附件的 blob URL，而乐观发送的图片 blob 在本会话内一直存活，被误 revoke 变坏图。
 * 修后改用 insertSpecialMessage（同 id 跳过去重、不 revoke）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/ws', () => ({
  wsClient: { request: vi.fn().mockResolvedValue({ type: 'ack' }) },
}));

import { routeChatEvent } from '@/hooks/useCommentChatRouter';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import type { ChatMessage, Conversation } from '@shared/types';

const CONV = 'cnv_main';

function seedMainConv(): void {
  const conv: Conversation = {
    id: CONV,
    ownerId: 'local-user',
    agentId: 'agt_1',
    kind: 'main',
    title: '',
    sdkSessionId: null,
    createdAt: 0,
    updatedAt: 0,
  };
  useConversationStore.setState({ byId: { [CONV]: conv } });
}

/** 乐观发送中的 user 消息：附件 displayUrl 是 blob:，本会话内必须一直存活 */
function optimisticUserMsg(): ChatMessage {
  return {
    id: 'u1',
    conversationId: CONV,
    role: 'user',
    text: '带图消息',
    toolCalls: [],
    createdAt: 0,
    done: true,
    attachments: [
      {
        kind: 'image',
        relPath: 'cnv_main/u1/img.png',
        mediaType: 'image/png',
        bytes: 10,
        filename: 'img.png',
        displayUrl: 'blob:oru/fake-optimistic-1',
      },
    ],
  };
}

function taskReportMsg(id = 'rep1'): ChatMessage {
  return {
    id,
    conversationId: CONV,
    role: 'assistant',
    text: '任务完成',
    toolCalls: [],
    createdAt: 1,
    done: true,
    kind: 'task-report',
    refId: 'tsk_1',
  };
}

beforeEach(() => {
  seedMainConv();
  useChatStore.setState({ conversations: { [CONV]: [optimisticUserMsg()] } });
});

describe('chat.taskReport 路由（M6 回归）', () => {
  it('追加 taskReport 不 revoke 既有乐观附件的 blob URL', () => {
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL');
    try {
      routeChatEvent({
        type: 'chat.taskReport',
        conversationId: CONV,
        taskId: 'tsk_1',
        message: taskReportMsg(),
      });
      const list = useChatStore.getState().conversations[CONV];
      expect(list.map((m) => m.id)).toEqual(['u1', 'rep1']);
      // 目标问题本身：blob URL 不能被误 revoke
      expect(revokeSpy).not.toHaveBeenCalled();
      // 既有消息对象与附件原样保留
      expect(list[0].attachments?.[0].displayUrl).toBe('blob:oru/fake-optimistic-1');
    } finally {
      revokeSpy.mockRestore();
    }
  });

  it('同 id taskReport 重复到达 → 去重跳过', () => {
    const ev = {
      type: 'chat.taskReport' as const,
      conversationId: CONV,
      taskId: 'tsk_1',
      message: taskReportMsg(),
    };
    routeChatEvent(ev);
    routeChatEvent(ev);
    const list = useChatStore.getState().conversations[CONV];
    expect(list.map((m) => m.id)).toEqual(['u1', 'rep1']);
  });
});

// 不变量：server 流式事件只更新「已加载历史」的对话桶，绝不新建桶。否则平台轮 / 定时任务投到
// 桌面未打开的对话时会拼出「缺历史的部分桶」，骗过 ChatArea 空桶拉取守卫 → 该对话永久缺前文。
describe('未加载对话桶守卫（防部分桶）', () => {
  const NL = 'cnv_not_loaded';

  function registerSubConv(id: string): void {
    const conv: Conversation = {
      id,
      ownerId: 'local-user',
      agentId: 'agt_1',
      kind: 'sub',
      title: '飞书 · 私聊',
      sdkSessionId: null,
      createdAt: 0,
      updatedAt: 0,
    };
    useConversationStore.setState((s) => ({ byId: { ...s.byId, [id]: conv } }));
  }

  function inboundUserEv(convId: string, id = 'fu1') {
    return {
      type: 'chat.inboundUserMessage' as const,
      conversationId: convId,
      message: {
        id,
        conversationId: convId,
        role: 'user' as const,
        text: '飞书发来的',
        toolCalls: [],
        createdAt: 5,
        done: true,
      },
    };
  }

  it('对话桶未加载（用户没打开过）→ 流式事件被丢弃，绝不新建部分桶', () => {
    registerSubConv(NL);
    // 关键前置：conversationStore 认得这条对话（conv.state 已同步），但 chatStore 从未加载其历史
    useChatStore.setState((s) => {
      const next = { ...s.conversations };
      delete next[NL];
      return { conversations: next };
    });

    routeChatEvent(inboundUserEv(NL));
    routeChatEvent({ type: 'chat.started', conversationId: NL, messageId: 'a1' });
    routeChatEvent({ type: 'chat.delta', conversationId: NL, messageId: 'a1', delta: { text: '回复中' } });

    // 桶仍不存在——没有被拼成「只剩这一轮、缺历史」的部分桶
    expect(NL in useChatStore.getState().conversations).toBe(false);
  });

  it('对话桶已加载（用户打开着）→ 平台入站 user 消息落桶', () => {
    registerSubConv(NL);
    // 用户打开过这条对话 → loadHistory 落了空桶（key 存在即「已加载」）
    useChatStore.setState((s) => ({ conversations: { ...s.conversations, [NL]: [] } }));

    routeChatEvent(inboundUserEv(NL));

    const list = useChatStore.getState().conversations[NL];
    expect(list.map((m) => m.id)).toEqual(['fu1']);
    expect(list[0].text).toBe('飞书发来的');
  });
});
