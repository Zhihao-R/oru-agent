/** @vitest-environment jsdom */
/**
 * promote 成功后的导航（runAsidePromoteNavigation，技术方案 §8）：
 * 切 chat 页（回调）、active 切到该对话、归档分组本地移除、光标入主输入框
 * （[data-chat-area] 区域的 textarea，rAF 后聚焦——ChatInput 无对外聚焦 ref）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation } from '@shared/types';

// 本模块只消费 conversationStore，但 store 模块 import 了 wsClient——mock 掉避免真连接
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async () => {
      throw new Error('导航不该发请求');
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { runAsidePromoteNavigation } from '@/aside/promoteNavigation';
import { useConversationStore } from '@/stores/conversationStore';

const ASIDE: Conversation = {
  id: 'c-aside',
  ownerId: 'local-user',
  agentId: 'a1',
  kind: 'aside',
  title: '一处空白',
  sdkSessionId: null,
  createdAt: 1000,
  updatedAt: 1000,
};

beforeEach(() => {
  useConversationStore.setState({
    byAgent: {},
    activeByAgent: { a1: 'c-main' },
    byId: { [ASIDE.id]: ASIDE },
    archivedByAgent: { a1: [ASIDE] },
  });
  document.body.innerHTML = '';
});

describe('runAsidePromoteNavigation', () => {
  it('切页 + 切对话 + 归档本地移除 + 光标入主输入框', () => {
    const showChatPage = vi.fn();
    const textarea = document.createElement('textarea');
    const area = document.createElement('section');
    area.setAttribute('data-chat-area', '');
    area.appendChild(textarea);
    document.body.appendChild(area);
    // rAF 同步回调：jsdom 无真实帧，只要时序推进
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });

    runAsidePromoteNavigation('a1', ASIDE.id, showChatPage);

    expect(showChatPage).toHaveBeenCalledTimes(1);
    const now = useConversationStore.getState();
    expect(now.activeByAgent['a1']).toBe(ASIDE.id);
    expect(now.archivedByAgent['a1']).toEqual([]);
    expect(document.activeElement).toBe(textarea);
    raf.mockRestore();
  });

  it('输入框不在 DOM（极端时序）→ 其余导航照常，不抛错', () => {
    const showChatPage = vi.fn();
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      });
    expect(() => runAsidePromoteNavigation('a1', ASIDE.id, showChatPage)).not.toThrow();
    expect(useConversationStore.getState().activeByAgent['a1']).toBe(ASIDE.id);
    raf.mockRestore();
  });
});
