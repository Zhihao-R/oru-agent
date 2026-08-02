/**
 * retryLast 分流合约测试：
 * 末尾 assistant 被中断 / 出错（无论有无半截内容）→ [重试] 走 chat.resume（就地重生成该 user 回合）；
 * 正常完成 → 走 chat.send（重发原问题）。
 *
 * 判据 = 末尾 assistant 被中断/出错（error=实时态 / interrupted=重载态），**不看半截有无 token**。
 * PT-001：起回合时 user 已先落盘，无产出中断也要 resume——若走 send 会再追加一条重复 user（user/user/assistant）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: { request: (...args: unknown[]) => requestMock(...args) },
}));

import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import type { ChatMessage, Conversation } from '@shared/types';

const CONV = 'cnv_test';
const AGENT = 'agt_1';

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

function msg(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'x',
    conversationId: CONV,
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: 0,
    done: true,
    ...partial,
  };
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
  seedConv();
});

describe('retryLast 分流：中途断从断点续 vs 重发', () => {
  it('重载态半截（有文字 + interrupted）→ 发 chat.resume（续跑）', async () => {
    useChatStore.setState({
      conversations: {
        [CONV]: [
          msg({ id: 'u1', role: 'user', text: '做个文件' }),
          msg({ id: 'a1', role: 'assistant', text: '我写到一半', interrupted: 'upstream_error' }),
        ],
      },
      lastSentByConv: { [CONV]: { text: '做个文件' } },
    });
    await useChatStore.getState().retryLast(CONV);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.resume', agentId: AGENT, conversationId: CONV }),
    );
  });

  it('实时态半截（只有悬空工具调用 + error）→ 发 chat.resume（续跑）', async () => {
    useChatStore.setState({
      conversations: {
        [CONV]: [
          msg({
            id: 'a1',
            role: 'assistant',
            text: '',
            toolCalls: [
              { id: 't', name: 'write_file', input: {}, status: 'running', startedAt: 0 },
            ],
            error: { message: '上游无响应', retryable: true },
          }),
        ],
      },
      lastSentByConv: { [CONV]: { text: '做个文件' } },
    });
    await useChatStore.getState().retryLast(CONV);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.resume' }));
  });

  // PT-001 回归：无产出中断（空 + error）以前误走 chat.send，会再追加一条重复 user 落盘。修复后走 resume。
  it('出错但无产出（空 + error）→ 发 chat.resume（不重发，不产生重复 user）', async () => {
    useChatStore.setState({
      conversations: {
        [CONV]: [
          msg({ id: 'u1', role: 'user', text: '做个文件' }),
          msg({ id: 'a1', role: 'assistant', text: '', error: { message: 'x', retryable: true } }),
        ],
      },
      lastSentByConv: { [CONV]: { text: '做个文件' } },
    });
    await useChatStore.getState().retryLast(CONV);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.resume', agentId: AGENT, conversationId: CONV }),
    );
    // 关键：绝不走 chat.send（那会再追加一条 user）
    expect(requestMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send' }));
  });

  // 本次 MAJOR 回归：空半截用户按停 → runChatAndPersist 抑制 chat.error（用户主动停不进通知中心）
  // → 占位 assistant 只有 abortedByUser=true（interrupted/error 均 undefined，因半截为空未落盘、
  // 也没 error）。StreamStatusBar 据 derivePhase(abortedByUser→aborted) 仍渲染 [重试]；点重试若只认
  // interrupted/error 会误走 chat.send 再追加一条重复 user（user/user/assistant）。retryLast 须与
  // derivePhase 对 aborted 的判据对齐，认 abortedByUser 为「已中断可续」。
  it('空半截用户按停（只有 abortedByUser 乐观标记）→ 发 chat.resume（不重发，不产生重复 user）', async () => {
    useChatStore.setState({
      conversations: {
        [CONV]: [
          msg({ id: 'u1', role: 'user', text: '做个文件' }),
          msg({ id: 'a1', role: 'assistant', text: '', abortedByUser: true }),
        ],
      },
      lastSentByConv: { [CONV]: { text: '做个文件' } },
    });
    await useChatStore.getState().retryLast(CONV);
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.resume', agentId: AGENT, conversationId: CONV }),
    );
    // 关键：绝不走 chat.send（那会再追加一条重复 user）
    expect(requestMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.send' }));
  });

  it('无产出中断（空 + interrupted 重载态）→ 同样走 chat.resume', async () => {
    useChatStore.setState({
      conversations: {
        [CONV]: [
          msg({ id: 'u1', role: 'user', text: '做个文件' }),
          msg({ id: 'a1', role: 'assistant', text: '', interrupted: 'user_stop' }),
        ],
      },
      lastSentByConv: { [CONV]: { text: '做个文件' } },
    });
    await useChatStore.getState().retryLast(CONV);
    expect(requestMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.resume' }));
  });

  it('正常完成的对话（有内容但无 error/interrupted）点重试 → 发 chat.send（不误走续跑）', async () => {
    useChatStore.setState({
      conversations: {
        [CONV]: [
          msg({ id: 'u1', role: 'user', text: '做个文件' }),
          msg({ id: 'a1', role: 'assistant', text: '做好了，给你' }),
        ],
      },
      lastSentByConv: { [CONV]: { text: '做个文件' } },
    });
    await useChatStore.getState().retryLast(CONV);
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'chat.send', text: '做个文件' }),
    );
  });
});
