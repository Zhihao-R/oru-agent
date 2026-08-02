/** @vitest-environment jsdom */
/**
 * Loop 常驻条（2026-07-28 拍板）行为：
 * - 收起态一行：第几轮（无分母）+ n/m 项达标 + 呼吸灯（运行中无「进行中」文本）；无停止按钮
 * - 点条展开：目标 + 全部标准，理由默认收起、点对应项才展开
 * - 点条外任意处收起
 * - 终态后下一条新消息到达 → 条自动退场
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { ChatMessage, LoopCardPayload } from '@shared/types';

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(_p: ClientRequestPayload): Promise<T> => {
      return { type: 'ok' } as unknown as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { LoopBar } from '@/components/chat/LoopBar';
import { useChatStore } from '@/stores/chatStore';

const CONV = 'cnv_loop1';

function msg(id: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    conversationId: CONV,
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: 1,
    done: true,
    ...over,
  };
}

function loopCard(over: Partial<LoopCardPayload> = {}): LoopCardPayload {
  return {
    loopId: 'loop1',
    goal: '把 README 改到能跑',
    phase: 'running',
    round: 2,
    maxRounds: 10,
    checklist: [
      { id: 'c1', statement: '步骤一条不缺', status: 'satisfied', verdict: { reason: '已补齐依赖安装' } },
      { id: 'c2', statement: '十分钟能读完', status: 'pending', verdict: { reason: '打回：正文太长' } },
      { id: 'c3', statement: '截图是新版', status: 'pending' },
    ],
    ...over,
  };
}

function setMessages(list: ChatMessage[]) {
  useChatStore.setState((s) => ({ conversations: { ...s.conversations, [CONV]: list } }));
}

/**
 * 详情区是「隐藏非卸载」（保加一项草稿，见 LoopBar 注释）——收起断言查 hidden 类而不是缺席。
 * 传文本：在详情区里找该文本节点，返回它最近的 hidden 祖先（展开态为 null）。
 */
function hiddenAncestorOf(text: string): Element | null {
  return screen.getByText(text).closest('.hidden');
}

beforeEach(() => {
  useChatStore.setState({ conversations: {} });
});
afterEach(cleanup);

describe('Loop 常驻条', () => {
  it('无 loop 卡的会话不渲染', () => {
    setMessages([msg('m1', { text: '普通消息' })]);
    const { container } = render(<LoopBar conversationId={CONV} />);
    expect(container.firstChild).toBeNull();
  });

  it('运行中收起态：第几轮（无分母）+ 项达标；无「进行中」文本、无停止按钮', () => {
    setMessages([msg('m1', { kind: 'loop-checklist', loopCard: loopCard() })]);
    render(<LoopBar conversationId={CONV} />);
    expect(screen.getByText('第 2 轮')).toBeTruthy();
    expect(screen.getByText('1 / 3 项达标')).toBeTruthy();
    expect(screen.queryByText('循环进行中')).toBeNull(); // round≥1 时不显示；呼吸灯不配文字
    expect(screen.queryByText('停止')).toBeNull();
    // 收起态标准不展示（隐藏非卸载：在 DOM 里但带 hidden）
    expect(hiddenAncestorOf('步骤一条不缺')).not.toBeNull();
  });

  it('点条展开标准（理由收起），点对应项展开理由；点条外收起', () => {
    setMessages([msg('m1', { kind: 'loop-checklist', loopCard: loopCard() })]);
    render(<LoopBar conversationId={CONV} />);

    fireEvent.click(screen.getByText('第 2 轮'));
    expect(screen.getByText('把 README 改到能跑')).toBeTruthy();
    expect(hiddenAncestorOf('十分钟能读完')).toBeNull(); // 展开态：详情区无 hidden
    expect(screen.queryByText('打回：正文太长')).toBeNull(); // 理由默认收起（条件渲染，缺席）

    fireEvent.click(screen.getByText('十分钟能读完'));
    expect(screen.getByText('打回：正文太长')).toBeTruthy();
    fireEvent.click(screen.getByText('十分钟能读完'));
    expect(screen.queryByText('打回：正文太长')).toBeNull();

    // 点条外任意处 → 收起（冒泡到 document 的条内点击不算条外，这里直接点 body）
    fireEvent.pointerDown(document.body);
    expect(hiddenAncestorOf('十分钟能读完')).not.toBeNull();
  });

  it('运行中展开态只有「加一项」控制', () => {
    setMessages([msg('m1', { kind: 'loop-checklist', loopCard: loopCard() })]);
    render(<LoopBar conversationId={CONV} />);
    fireEvent.click(screen.getByText('第 2 轮'));
    expect(screen.getByText('加一项')).toBeTruthy();
    expect(screen.queryByText('停止')).toBeNull();
    expect(screen.queryByTitle('划掉')).toBeNull();
  });

  it('终态（全部达标）陈列终态词；下一条新消息到达 → 自动退场', () => {
    // 终态卡带 endedAt（老数据无 endedAt 视为早已退场）；「之后有没有新消息」按 createdAt 客观派生
    const doneCard = loopCard({ phase: 'done', round: 3, stopReason: 'all-satisfied', endedAt: 5 });
    setMessages([
      msg('m1', { kind: 'loop-checklist', loopCard: doneCard }),
      msg('m2', { text: '收尾说明', createdAt: 2 }),
    ]);
    const { container } = render(<LoopBar conversationId={CONV} />);
    expect(screen.getByText('循环完成 · 第 3 轮达标')).toBeTruthy();

    // 终态锚点后追加新消息（createdAt 晚于 endedAt）→ 退场（挂载后的 store 更新要进 act 让 React 刷完）
    act(() => {
      setMessages([
        msg('m1', { kind: 'loop-checklist', loopCard: doneCard }),
        msg('m2', { text: '收尾说明', createdAt: 2 }),
        msg('m3', { text: '用户又说了句话', role: 'user', createdAt: 10 }),
      ]);
    });
    expect(container.firstChild).toBeNull();
  });

  it('终态展开不显示「加一项」', () => {
    const doneCard = loopCard({ phase: 'done', round: 3, stopReason: 'all-satisfied', endedAt: 5 });
    setMessages([msg('m1', { kind: 'loop-checklist', loopCard: doneCard })]);
    render(<LoopBar conversationId={CONV} />);
    fireEvent.click(screen.getByText('循环完成 · 第 3 轮达标'));
    expect(screen.queryByText('加一项')).toBeNull();
  });
});
