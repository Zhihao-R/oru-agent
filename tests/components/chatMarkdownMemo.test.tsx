/**
 * 回归：ChatMarkdown 包 React.memo 后，source 内容不变时父级任意重渲染不再触发
 * react-markdown 重 parse + 语法高亮（治「列表每次重渲染把当前界面全部消息重新解析一遍」的 CPU 风暴，
 * docs/plans/2026-08-03-聊天markdown重渲染CPU风暴修复-plan.md 改动 1）。
 *
 * 验证目标问题本身（确定性调用次数断言，不建 CPU % 评分器）：
 * - 父组件本地 state 变化触发重渲染但 source 不变 → mock 的 MarkdownDoc 渲染次数相对首屏不递增；
 * - source 内容真变化（流式追加/编辑）→ 渲染次数递增 → 证明 memo 没把真实更新挡死。
 *
 * 断言语义用「相对首屏调用次数不递增」而非绝对 == 1：dev 下 vite react 插件默认包 StrictMode
 * 挂载期会双调用 mock（绝对计数误红），测试环境也按同一语义写以兜底。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

import { ChatMarkdown } from '@/components/chat/ChatMarkdown';

afterEach(() => {
  cleanup();
  markdownDocCalls.n = 0;
});

// 包装组件：本地 state tick 触发父级重渲染，source 由外部开关控制
function Wrapper({ initialSource }: { initialSource: string }) {
  const [source, setSource] = useState(initialSource);
  const [tick, setTick] = useState(0);
  return (
    <div>
      <button onClick={() => setTick((t) => t + 1)}>rerender</button>
      <button onClick={() => setSource('v2 内容')}>change source</button>
      <ChatMarkdown source={source} />
    </div>
  );
}

describe('ChatMarkdown memo（改动 1）', () => {
  it('父组件重渲染但 source 不变：不重新解析', () => {
    const { getByText } = render(<Wrapper initialSource="v1 内容" />);
    // 首屏渲染次数作为基线（不写死 == 1，StrictMode 防御）
    expect(markdownDocCalls.n).toBeGreaterThan(0);
    const baseline = markdownDocCalls.n;

    for (let i = 0; i < 5; i += 1) {
      fireEvent.click(getByText('rerender'));
    }
    expect(markdownDocCalls.n).toBe(baseline);
    expect(screen.getByText('v1 内容')).toBeTruthy();
  });

  it('source 内容变化：正常重新解析（memo 不挡真实更新）', () => {
    const { getByText } = render(<Wrapper initialSource="v1 内容" />);
    const baseline = markdownDocCalls.n;

    // 先无谓重渲染几次，确认基线稳定，再改 source
    for (let i = 0; i < 3; i += 1) fireEvent.click(getByText('rerender'));
    expect(markdownDocCalls.n).toBe(baseline);

    fireEvent.click(getByText('change source'));
    expect(markdownDocCalls.n).toBeGreaterThan(baseline);
    expect(screen.getByText('v2 内容')).toBeTruthy();
  });
});
