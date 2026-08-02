/** @vitest-environment jsdom */
/**
 * Subagent 终态完成行（2026-07-30 拍板：完成卡降级为工具行形态）：
 * - 完成行 = 无边框脚注行：状态点 + fork icon + mono 标题；摘要不进流（finalText/errorMessage 不上屏）
 * - 点击开详情浮层：徽章 + 标题 + 耗时 + 状态点；派工 / 内部对话（懒加载 sidecar）/ 返回（失败给原因）/ Token
 * - 相邻 ≥2 条终态由 SubagentGroup 收成「N 个 subagent」，点开逐行；单条退化单行
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { ChatMessage, SubagentChipRef } from '@shared/types';

const requestMock = vi.fn(async (p: ClientRequestPayload): Promise<ServerEventPayload> => {
  if (p.type === 'conv.getSubagentSidecar') {
    return {
      type: 'conv.subagentSidecar.result',
      agentId: p.agentId,
      conversationId: p.conversationId,
      taskId: p.taskId,
      messages: [innerMsg('inner1', '内部第一步：先搜资料')],
    };
  }
  throw new Error(`unexpected request: ${p.type}`);
});

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (p: ClientRequestPayload) => requestMock(p),
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { SubagentChip, SubagentGroup } from '@/components/chat/SubagentChip';
import { useAgentStore } from '@/stores/agentStore';

const CONV = 'cnv_chip1';

function innerMsg(id: string, text: string): ChatMessage {
  // 普通文本消息 kind 缺省（ChatMessageKind 联合里没有 'text'）
  return {
    id,
    conversationId: CONV,
    role: 'assistant',
    text,
    toolCalls: [],
    createdAt: 1,
    done: true,
  };
}

function chipMsg(id: string, ref: Partial<SubagentChipRef> & { status: SubagentChipRef['status'] }): ChatMessage {
  return {
    id,
    conversationId: CONV,
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: 1,
    done: true,
    kind: 'subagent',
    subagent: {
      taskId: `sub_${id}`,
      description: `任务${id}`,
      prompt: `派工：${id}`,
      startedAt: 1000,
      ...ref,
    },
  };
}

beforeEach(() => {
  requestMock.mockClear();
  useAgentStore.setState({ agents: [], activeAgentId: 'a1' });
});
afterEach(() => {
  cleanup();
});

describe('Subagent 终态完成行', () => {
  it('完成行只渲染 mono 标题：finalText 摘要不进流、无「完成」文字', () => {
    render(
      <SubagentChip
        message={chipMsg('c1', { status: 'completed', completedAt: 43000, finalText: '这是一段很长的结果摘要，不该出现在流里' })}
      />,
    );
    expect(screen.getByText('任务c1')).toBeTruthy();
    expect(screen.queryByText(/结果摘要/)).toBeNull();
    expect(screen.queryByText('完成')).toBeNull();
  });

  it('失败行同样只给标题：errorMessage 不上屏（失败只红不配文字）', () => {
    render(<SubagentChip message={chipMsg('c2', { status: 'error', completedAt: 20000, errorMessage: '抓取超时：连续 3 次无响应' })} />);
    expect(screen.getByText('任务c2')).toBeTruthy();
    expect(screen.queryByText(/抓取超时/)).toBeNull();
    expect(screen.queryByText('失败')).toBeNull();
  });

  it('运行中 chip 不归本组件渲染（活物沉底，由 SubagentBar 承载）', () => {
    const { container } = render(<SubagentChip message={chipMsg('c3', { status: 'running' })} />);
    expect(container.firstChild).toBeNull();
  });

  it('点击开详情浮层：徽章 + 标题 + 耗时；派工 / 返回 / Token；懒加载内部对话', async () => {
    render(
      <SubagentChip
        message={chipMsg('c1', {
          status: 'completed',
          completedAt: 43000,
          finalText: '数据已齐，汇总如下',
          tokenUsage: { input: 12480, output: 1932, cacheRead: 8204 },
        })}
      />,
    );
    // 未打开前不拉 sidecar
    expect(requestMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('任务c1'));
    expect(screen.getByText('subagent')).toBeTruthy(); // 徽章
    expect(screen.getByText('42.0s')).toBeTruthy(); // 耗时 = completedAt - startedAt
    expect(screen.getByText('派工：c1')).toBeTruthy();
    expect(screen.getByText('数据已齐，汇总如下')).toBeTruthy();
    expect(screen.getByText(/in 12480 \/ out 1932 \/ cache 8204/)).toBeTruthy();

    // 打开后才懒加载内部对话，渲染 sidecar 消息
    expect(requestMock).toHaveBeenCalledWith({
      type: 'conv.getSubagentSidecar',
      agentId: 'a1',
      conversationId: CONV,
      taskId: 'sub_c1',
    });
    await act(async () => {});
    expect(screen.getByText('内部第一步：先搜资料')).toBeTruthy();
  });

  it('失败浮层：失败原因 danger 段取代返回段；Token 成败都展示（runner 无条件落盘）', async () => {
    render(
      <SubagentChip
        message={chipMsg('c2', {
          status: 'error',
          completedAt: 20000,
          errorMessage: '抓取超时：连续 3 次无响应',
          tokenUsage: { input: 3200, output: 410, cacheRead: 0 },
        })}
      />,
    );
    fireEvent.click(screen.getByText('任务c2'));
    expect(screen.getByText('19.0s')).toBeTruthy();
    expect(screen.getByText('抓取超时：连续 3 次无响应')).toBeTruthy();
    expect(screen.getByText(/in 3200 \/ out 410/)).toBeTruthy();
  });
});

describe('SubagentGroup 相邻折叠', () => {
  it('单条直接退化单行，不出折叠计数行', () => {
    render(<SubagentGroup messages={[chipMsg('c1', { status: 'completed', completedAt: 9000 })]} />);
    expect(screen.getByText('任务c1')).toBeTruthy();
    expect(screen.queryByText(/个 subagent/)).toBeNull();
  });

  it('≥2 条收成「N 个 subagent」，点开逐行、再点收起', () => {
    render(
      <SubagentGroup
        messages={[
          chipMsg('c1', { status: 'completed', completedAt: 9000 }),
          chipMsg('c2', { status: 'error', completedAt: 9500, errorMessage: 'x' }),
        ]}
      />,
    );
    // 收起态：逐行标题不可见
    expect(screen.queryByText('任务c1')).toBeNull();
    fireEvent.click(screen.getByText('2 个 subagent'));
    expect(screen.getByText('任务c1')).toBeTruthy();
    expect(screen.getByText('任务c2')).toBeTruthy();
    fireEvent.click(screen.getByText('收起'));
    expect(screen.queryByText('任务c1')).toBeNull();
  });
});
