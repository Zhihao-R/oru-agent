/**
 * 定时任务确认卡（2026-07-20 拍板）：创建落盘（structured.scheduledTask 标记）后出卡，
 * 内容从 scheduledTaskStore 实时取（频率 + 下次运行），任务已删则不渲染；「管理」走跳页缝。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { setPageNavigator, type NavigablePage } from '@/lib/pageNavigator';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';
import type { ChatMessage as Msg, TaskGroup, ToolCall } from '@shared/types';

// 卡片从 store 的聚合 groups 取（按 groupId 渲一张）；rules 里含底层 taskId 供 marker 对齐。
const GROUP: TaskGroup = {
  groupId: 'st1',
  title: '每周销售数据整理',
  prompt: '整理上周销售数据',
  runLocation: { kind: 'newConversation' },
  createdBy: 'agent',
  enabled: true,
  rules: [
    {
      taskId: 'st1',
      spec: { kind: 'weekly', weekdays: [1], minutesOfDay: 540 },
      nextRunAt: Date.now() + 86_400_000,
      enabled: true,
    },
  ],
  nextRunAt: Date.now() + 86_400_000,
  runHistory: [],
  createdAt: 1,
};

function createTool(taskId: string | null): ToolCall {
  return {
    id: 't1',
    name: 'mcp__oru__manage_scheduled_task',
    input: { action: 'create' },
    status: 'success',
    startedAt: 1000,
    finishedAt: 1200,
    result: {
      toolCallId: 't1',
      isError: false,
      summary: 'ok',
      ...(taskId ? { structured: { scheduledTask: { taskId } } } : {}),
    },
  };
}

function msg(toolCalls: ToolCall[], done = true): Msg {
  return { id: 'm1', conversationId: 'c1', role: 'assistant', text: '', toolCalls, createdAt: 1, done };
}

beforeEach(() => {
  useScheduledTaskStore.setState({ groups: [GROUP] });
});
afterEach(() => {
  cleanup();
  setPageNavigator(null);
});

describe('定时任务确认卡', () => {
  it('创建落盘：出卡，含标题 + 频率 + 下次运行；「管理」触发跳页缝', () => {
    const navigated: NavigablePage[] = [];
    setPageNavigator((p) => navigated.push(p));
    render(<ChatMessage message={msg([createTool('st1')])} />);
    expect(screen.getByText('每周销售数据整理')).toBeTruthy();
    expect(screen.getByText(/周一.*09:00/)).toBeTruthy();
    expect(screen.getByText(/下次运行/)).toBeTruthy();
    fireEvent.click(screen.getByText('管理 →'));
    expect(navigated).toEqual(['scheduledTask']);
  });

  it('无落盘标记（审批被拒等）：不出卡', () => {
    render(<ChatMessage message={msg([createTool(null)])} />);
    expect(screen.queryByText('每周销售数据整理')).toBeNull();
  });

  it('任务已删：不渲染过期卡', () => {
    useScheduledTaskStore.setState({ groups: [] });
    render(<ChatMessage message={msg([createTool('st1')])} />);
    expect(screen.queryByText('管理 →')).toBeNull();
  });
});
