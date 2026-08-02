/**
 * ScheduledRunCard 空 title 兜底（打磨 6b）：存量空串 title 的历史任务，
 * 渲染层要兜成「定时任务 · 已完成」而不是「定时任务 · · 已完成」（`??` 兜不住空串，改 `||`）。
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
import type { ChatMessage as Msg } from '@shared/types';

afterEach(cleanup);

function runMessage(title: string): Msg {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'assistant',
    kind: 'scheduled-run',
    text: '',
    toolCalls: [],
    createdAt: 1,
    done: true,
    scheduledRun: { taskId: 'task_1', title, status: 'ok' },
  } satisfies Msg;
}

describe('ScheduledRunCard · 空 title 兜底（打磨 6b）', () => {
  it("title='' → 显示兜底名「定时任务」，不出现双间隔符", () => {
    const { container } = render(<ChatMessage message={runMessage('')} />);
    const text = container.textContent ?? '';
    expect(text).toContain('定时任务');
    expect(text).not.toContain('· ·'); // 空 title 穿透时的病态形态
  });

  it('title 非空 → 照常显示任务名', () => {
    render(<ChatMessage message={runMessage('晨间简报')} />);
    expect(screen.getByText(/晨间简报/)).toBeTruthy();
  });
});
