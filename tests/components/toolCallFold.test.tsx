/**
 * 工具调用收起策略（2026-07-20 UI/UX 拍板）的行为回归。
 *
 * 规则：已完成的调用 1 条贴行内一行、≥2 条收成计数行「N 个工具」（不带状态、不列名）；
 * 进行中的最新调用永远单独一行实时显示、不纳入收起；失败只靠红色标识、无文字；
 * 点单条工具行上详情浮层（输入/结果）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
import type { ChatMessage as Msg, ToolCall, ToolCallStatus } from '@shared/types';

afterEach(cleanup);

let seq = 0;
function tc(name: string, status: ToolCallStatus, extra?: Partial<ToolCall>): ToolCall {
  seq += 1;
  return {
    id: `t${seq}`,
    name,
    input: { cmd: `${name}-input` },
    status,
    startedAt: 1000,
    finishedAt: status === 'success' || status === 'error' ? 1400 : undefined,
    ...extra,
  };
}

function msg(toolCalls: ToolCall[], done = true): Msg {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    text: '',
    toolCalls,
    createdAt: 1,
    done,
  };
}

describe('工具调用收起策略', () => {
  it('单条已完成：贴行内一行直接显示，无收起行', () => {
    render(<ChatMessage message={msg([tc('bash', 'success')])} />);
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.queryByText(/个工具/)).toBeNull();
  });

  it('多条已完成：收成「N 个工具」计数行，不列名、含失败也无任何状态文字', () => {
    render(
      <ChatMessage
        message={msg([tc('bash', 'success'), tc('glob', 'success'), tc('bash', 'error')])} />,
    );
    expect(screen.getByText('3 个工具')).toBeTruthy();
    expect(screen.queryByText('glob')).toBeNull();
    expect(screen.queryByText('bash')).toBeNull();
    expect(screen.queryByText(/失败|错误|error/i)).toBeNull();
  });

  it('点开计数行：逐条列出（含失败条目），再点可收起', () => {
    render(
      <ChatMessage message={msg([tc('bash', 'success'), tc('glob', 'success')])} />,
    );
    fireEvent.click(screen.getByText('2 个工具'));
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.getByText('glob')).toBeTruthy();
    fireEvent.click(screen.getByText('收起'));
    expect(screen.queryByText('bash')).toBeNull();
  });

  it('流式中最新调用进行中：单独一行实时显示，之前的收进计数行', () => {
    render(
      <ChatMessage
        message={msg(
          [tc('bash', 'success'), tc('glob', 'success'), tc('read_file', 'running')],
          false,
        )} />,
    );
    expect(screen.getByText('2 个工具')).toBeTruthy();
    expect(screen.getByText('read_file')).toBeTruthy();
    expect(screen.queryByText('glob')).toBeNull();
  });

  it('中断落盘的悬空 running：消息已定居（done）即视作已完成，一并收起（回归）', () => {
    render(
      <ChatMessage
        message={msg([tc('bash', 'success'), tc('glob', 'success'), tc('read_file', 'running')])} />,
    );
    expect(screen.getByText('3 个工具')).toBeTruthy();
    expect(screen.queryByText('read_file')).toBeNull();
  });

  it('失败条目展开后靠红色标识（正向断言，防红色被改掉仍绿）', () => {
    render(
      <ChatMessage message={msg([tc('bash', 'success'), tc('glob', 'error')])} />,
    );
    fireEvent.click(screen.getByText('2 个工具'));
    expect(screen.getByText('glob').className).toContain('text-danger');
    expect(screen.getByText('bash').className).not.toContain('text-danger');
  });

  it('带 mcp__oru__ 前缀的落盘名：行内展示剥前缀（回归）', () => {
    render(<ChatMessage message={msg([tc('mcp__oru__bash', 'success')])} />);
    expect(screen.getByText('bash')).toBeTruthy();
    expect(screen.queryByText(/mcp__oru__/)).toBeNull();
  });

  it('点工具行：上详情浮层，展示输入与结果', () => {
    render(
      <ChatMessage
        message={msg([
          tc('bash', 'error', {
            result: {
              toolCallId: 't-x',
              isError: true,
              summary: 'wkhtmltopdf not found',
              detail: 'wkhtmltopdf not found',
            },
          }),
        ])} />,
    );
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText('输入')).toBeTruthy();
    expect(screen.getByText(/bash-input/)).toBeTruthy();
    expect(screen.getByText('wkhtmltopdf not found')).toBeTruthy();
  });
});
