/** @vitest-environment jsdom */
/**
 * 通知中心入口（AgentChip）与面板（AgentTaskPanel）两个回归：
 * 1. 点「已完成（待验收）」对话要把可见页面拨回 chat——面板挂在 TopBar，可能停在非 chat 页，
 *    只 setActive 改不了当前页（原 bug：点了不跳转）。
 * 2. 入口对「未读待验收」要有可见提示（原本只有待办数字，待验收不产生任何提示）——
 *    2026-07-14 PM 拍板并入总闸：无待办时角标显待验收条数，恒实心琥珀圆（--warn）。
 * 3. 有待验收 / 进行中时，面板顶部不再说「Oru 这边都妥了」（与下方列表自相矛盾）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import i18n from 'i18next';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { Conversation } from '@shared/types';

import { AgentTaskPanel } from '@/components/AgentTaskPanel';
import { AgentChip } from '@/components/AgentChip';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useChatStore } from '@/stores/chatStore';
import { useTaskStore } from '@/stores/taskStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { wsClient } from '@/lib/ws';

// markSeen 会 fire-and-forget 打 conv.markSeen；不真连后端，直接吞掉
const origRequest = wsClient.request;
function stubWs() {
  wsClient.request = (async (_p: ClientRequestPayload): Promise<ServerEventPayload> =>
    ({ type: 'ok' }) as unknown as ServerEventPayload) as typeof wsClient.request;
}

function conv(id: string, title: string, updatedAt: number, lastSeenAt?: number): Conversation {
  return {
    id,
    ownerId: 'local-user',
    agentId: 'a1',
    kind: 'sub',
    title,
    sdkSessionId: null,
    createdAt: 1000,
    updatedAt,
    lastSeenAt,
  };
}

// 一条「已完成且未读」对话：无待办、无任务、无流式 → state=done；updatedAt>lastSeenAt → unread
const DONE = conv('c-done', '查看编辑文件', 5000, 1000);

beforeEach(async () => {
  // 锁定语言：测试 setup(zh) 与 lib/i18n(localStorage 派生) 抢同一 i18next 单例，
  // 渲染语言随 import 时序漂移；显式 changeLanguage 钉死，文案断言才确定。
  await i18n.changeLanguage('zh');
  stubWs();
  useAgentStore.setState({ agents: [{ id: 'a1', name: 'Oru', homePath: '/x' }], activeAgentId: 'a1' });
  useConversationStore.setState({
    byAgent: { a1: [DONE] },
    byId: { [DONE.id]: DONE },
    activeByAgent: {},
    archivedByAgent: {},
  });
  useChatStore.setState({ streamingMessageIdByConv: {}, conversations: {} });
  useTaskStore.setState({ tasks: {}, proposalsByConv: {} });
  useNotificationStore.setState({ dismissedAt: {} });
});

afterEach(() => {
  cleanup();
  wsClient.request = origRequest;
});

describe('通知中心跳转 + 入口提示', () => {
  it('点已完成对话：调 onGoChat（拨回 chat 页）并 setActive 到该对话', () => {
    let wentChat = false;
    render(<AgentTaskPanel onClose={() => {}} onGoChat={() => (wentChat = true)} />);

    fireEvent.click(screen.getByText('查看编辑文件'));

    expect(wentChat).toBe(true);
    expect(useConversationStore.getState().activeByAgent.a1).toBe('c-done');
  });

  it('有待验收项时，面板顶部不出现「都妥了」横幅', () => {
    render(<AgentTaskPanel onClose={() => {}} />);
    // 完成段标题在（段标题缩为「完成 · N」，待验收下放到副文本），矛盾的「都妥了」横幅不在（语言已锁 zh）
    expect(screen.getByText(/^完成 · \d+$/)).toBeTruthy();
    expect(screen.queryByText(/这边都妥了/)).toBeNull();
  });

  it('入口：仅有未读待验收时，角标显实心琥珀数字圆（并入待办同一枚总闸，2026-07-14 PM 拍板）', () => {
    // 待验收不再另给绿静点：无待办时角标显待验收条数，恒实心琥珀圆(--warn)、非在跑无晕圈
    const { container } = render(<AgentChip />);
    const badge = container.querySelector('span.bg-warn');
    expect(badge).toBeTruthy();
    expect(badge?.textContent).toBe('1');
    expect(container.querySelector('.oru-halo')).toBeNull();
  });
});
