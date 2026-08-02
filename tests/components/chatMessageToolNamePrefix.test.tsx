/**
 * ChatMessage 的 ask_user_choice 分发在带前缀工具名下的回归。
 *
 * 目标问题：claude-code 后端落盘的 toolCall.name 是 mcp__oru__ask_user_choice，
 * renderToolCard / ToolCallStack 按裸名精确匹配——回放时提问卡退化成通用灰条卡，
 * 且卡头露出内部代号。修复 = 比对前归一工具名。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(_payload: ClientRequestPayload): Promise<T> => {
      throw new Error('本测试不应触发 ws 请求');
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { ChatMessage } from '@/components/chat/ChatMessage';
import type { ChatMessage as Msg, ToolCall } from '@shared/types';

afterEach(cleanup);

function askMessage(toolName: string): Msg {
  const toolCalls: ToolCall[] = [
    {
      id: 't1',
      name: toolName,
      input: { questions: [{ header: '风格', question: '要哪种风格？', options: [{ label: '简约' }] }] },
      status: 'success',
      startedAt: 1,
      result: {
        toolCallId: 't1',
        isError: false,
        summary: '',
        detail: '',
        structured: { answers: [{ questionIndex: 0, selectedLabels: ['简约'] }] },
      },
    },
  ];
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    text: '',
    toolCalls,
    createdAt: 1,
    done: true,
  };
}

describe('ask_user_choice 回放 · 工具名前缀归一', () => {
  it('裸名：渲染只读小结（既有行为）', () => {
    render(<ChatMessage message={askMessage('ask_user_choice')} />);
    expect(screen.getByText('风格')).toBeTruthy();
    expect(screen.getByText('简约')).toBeTruthy();
  });

  it('带 mcp__oru__ 前缀（claude-code 落盘名）：仍渲染只读小结、不露内部代号（回归）', () => {
    render(<ChatMessage message={askMessage('mcp__oru__ask_user_choice')} />);
    expect(screen.getByText('风格')).toBeTruthy();
    expect(screen.queryByText(/mcp__oru__/)).toBeNull();
  });
});
