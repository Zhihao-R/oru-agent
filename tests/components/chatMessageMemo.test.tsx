/**
 * 回归：ChatMessage 导出包 React.memo 后，父组件因无关原因重渲染不再连坐整条消息子树
 * 重渲染（其内 markdown 也不再重解析）——docs/plans/2026-08-03-聊天markdown重渲染CPU风暴修复-plan.md 改动 2。
 *
 * 验证目标问题本身（确定性调用次数断言，不建 CPU % 评分器）：
 * - 父组件本地 state 变化触发重渲染但 message 引用不变 → 消息内 mock 的 MarkdownDoc 不被重新调用；
 * - 向列表 push 新消息 → 正常新增渲染（memo 不挡真实新增）；
 * - store 驱动路径（评审要求）：pendingAsks 被 push → AssistantBlock 因 store 订阅独立重渲染、
 *   但 message 引用不变 → 消息内 MarkdownDoc 仍不被重新调用（改动 2 只挡「父重渲染」这条，
 *   store 订阅是独立通道，靠改动 1 的 ChatMarkdown memo 兜住 re-parse，这里一并锁进）。
 *
 * 断言语义用「相对首屏调用次数不递增」而非绝对 == 1（StrictMode 防御，见 chatMarkdownMemo.test.tsx）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

const { MarkdownDoc, markdownDocCalls } = vi.hoisted(() => {
  const markdownDocCalls = { n: 0 };
  return {
    markdownDocCalls,
    MarkdownDoc: (props: {
      content: string;
      docIdentity?: unknown;
      inlineCode?: unknown;
      paragraph?: unknown;
    }) => {
      markdownDocCalls.n += 1;
      return <div data-testid="md">{props.content}</div>;
    },
  };
});

vi.mock('@/lib/markdownRender', () => ({ MarkdownDoc }));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async () => {
      throw new Error('本测试不应触发 ws 请求');
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import type { ChatMessage as Msg } from '@shared/types';
import { ChatMessage } from '@/components/chat/ChatMessage';
import { useChatStore } from '@/stores/chatStore';

const CONV = 'conv_1';

function assistantMsg(id: string): Msg {
  return {
    id,
    conversationId: CONV,
    role: 'assistant',
    text: `回复 ${id}`,
    toolCalls: [],
    createdAt: 100,
    done: true,
  };
}

// 父组件：本地 state tick 触发重渲染，messages 元素引用稳定（来自外部传入）
function ListHost({ messages }: { messages: Msg[] }) {
  const [tick, setTick] = useState(0);
  return (
    <div>
      <button onClick={() => setTick((t) => t + 1)}>rerender</button>
      {messages.map((m) => (
        <ChatMessage key={m.id} message={m} />
      ))}
    </div>
  );
}

beforeEach(() => {
  markdownDocCalls.n = 0;
  useChatStore.setState({ conversations: {} });
});

afterEach(() => {
  cleanup();
  useChatStore.setState({ conversations: {}, pendingAsks: {} });
});

describe('ChatMessage memo（改动 2）', () => {
  it('父组件重渲染但 message 引用不变：不重渲染、内部 markdown 不重解析', () => {
    const messages = [assistantMsg('m1')];
    const { getByText } = render(<ListHost messages={messages} />);
    const baseline = markdownDocCalls.n;
    expect(baseline).toBeGreaterThan(0);
    expect(screen.getByText('回复 m1')).toBeTruthy();

    for (let i = 0; i < 5; i += 1) fireEvent.click(getByText('rerender'));
    expect(markdownDocCalls.n).toBe(baseline);
  });

  it('push 新消息：正常新增渲染（memo 不挡真实新增）', () => {
    const messages = [assistantMsg('m1')];
    const { getByText, rerender } = render(<ListHost messages={messages} />);
    const baseline = markdownDocCalls.n;

    // 无谓重渲染若干次，基线稳定
    for (let i = 0; i < 3; i += 1) fireEvent.click(getByText('rerender'));
    expect(markdownDocCalls.n).toBe(baseline);

    // 新增一条消息（重构数组、新元素引用）
    const next = [assistantMsg('m1'), assistantMsg('m2')];
    rerender(<ListHost messages={next} />);
    expect(markdownDocCalls.n).toBeGreaterThan(baseline);
    expect(screen.getByText('回复 m2')).toBeTruthy();
  });

  it('store 驱动路径：pendingAsks push 触发子组件独立重渲染，但消息内 markdown 不重解析', () => {
    // 直接渲染单条 assistant 消息（不套 ListHost，聚焦 store 订阅通道）
    const msg = assistantMsg('m1');
    const { container } = render(<ChatMessage message={msg} />);
    const baseline = markdownDocCalls.n;
    expect(baseline).toBeGreaterThan(0);

    // 注入与 m1 匹配的 pendingAsk → AssistantBlock 的 pendingAsks selector 变化 → 独立重渲染
    act(() => {
      useChatStore.getState().addPendingAsk(CONV, 'm1', 'ask1', [
        { header: 'q', question: '要哪种？', options: [{ label: 'A' }] },
      ]);
    });

    // store 驱动的重渲染确实发生了（锚点文案出现），但 markdown 未被重新解析
    expect(screen.getByText('等你回答 · 请于下方处理')).toBeTruthy();
    expect(markdownDocCalls.n).toBe(baseline);

    // 清掉 pendingAsk（anchor 消失），markdown 仍不受影响
    act(() => {
      useChatStore.setState((s) => {
        const next = { ...s.pendingAsks };
        delete next.ask1;
        return { pendingAsks: next };
      });
    });
    expect(markdownDocCalls.n).toBe(baseline);
    expect(container.textContent).not.toContain('等你回答');
  });
});
