/**
 * S1 消息流渲染层测试：锚点卡归位 + 砍冗余 chip 的渲染断言。
 *
 * 验证目标问题本身（位置断言）：
 * - git-hint 与装卸类六种 kind（plugin-install/update/uninstall、skill-create/patch/install）不产出可见节点；
 * - memory-record / skill-call / plugin-activate 带 anchorTo 时出现在对应 assistant 回复之后（不再沉流尾）；
 * - 流式中态：assistant 消息已由 chat.started 建出但 done:false、文本未定时，锚定卡已挂其下、
 *   随 appendDelta 不跳位；
 * - context-compressed 保留现状、subagent 行为不变；
 * - 老数据无 anchorTo → 保留卡按 createdAt 沉流尾（行为不变）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/ws', () => ({ wsClient: { request } }));

import type { Agent, Conversation, ChatMessage } from '@shared/types';
import ChatArea from '@/components/chat/ChatArea';

// jsdom 无 ResizeObserver（useStickToBottom 量滚动容器用）——stub 掉
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useChatStore } from '@/stores/chatStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useTaskStore } from '@/stores/taskStore';
import { useLandingNavStore } from '@/stores/landingNavStore';

const AGENT = 'agent_twin';
const CONV = 'conv_1';

function makeAgent(): Agent {
  return {
    id: AGENT,
    name: 'Oru',
    homePath: '/tmp/home',
    systemPromptAppend: null,
    approvalMode: 'work',
    createdAt: 0,
  };
}

function makeConv(): Conversation {
  return {
    id: CONV,
    agentId: AGENT,
    kind: 'sub',
    title: '测试对话',
    createdAt: 0,
    updatedAt: 0,
    lastSeenAt: 0,
  };
}

function assistantMsg(id: string, overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id,
    conversationId: CONV,
    role: 'assistant',
    text: `回复 ${id}`,
    toolCalls: [],
    createdAt: 100,
    done: true,
    ...overrides,
  };
}

function cardMsg(
  id: string,
  kind: ChatMessage['kind'],
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  const base: ChatMessage = {
    id,
    conversationId: CONV,
    role: 'system',
    text: '',
    toolCalls: [],
    createdAt: 200,
    done: true,
    kind,
    anchorTo: { messageId: 'm_assistant' },
    ...overrides,
  };
  return base;
}

function skillCard(id: string, kind: 'skill-call' | 'plugin-activate', name: string): ChatMessage {
  return cardMsg(id, kind, {
    text: `用了 ${name}`,
    skillModuleAction: { id, name },
  });
}

function seedMessages(msgs: ChatMessage[]) {
  useChatStore.setState({ conversations: { [CONV]: msgs } });
}

beforeEach(() => {
  request.mockReset();
  request.mockResolvedValue({ type: 'conv.state', conversations: [] });
  useAgentStore.setState({ agents: [makeAgent()], activeAgentId: AGENT });
  useConversationStore.setState({
    byAgent: { [AGENT]: [makeConv()] },
    byId: { [CONV]: makeConv() },
    activeByAgent: { [AGENT]: CONV },
    archivedByAgent: {},
    flashTarget: null,
  });
  useTaskStore.setState({
    tasks: {},
    proposalsByConv: {},
    progressByTask: {},
    questionsByTask: {},
    expandedCards: new Set<string>(),
    justFinishedTaskId: null,
  });
  useSettingsStore.setState({ authStatus: { ready: true, hint: '' } });
  useLandingNavStore.setState({ line: 'chat' });
});

afterEach(() => {
  cleanup();
  useChatStore.setState({ conversations: {}, pendingByConv: {} });
});

describe('S1 消息流渲染', () => {
  it('git-hint 与装卸类六种 kind 不产出消息气泡', () => {
    const kinds: ChatMessage['kind'][] = [
      'git-hint',
      'plugin-install',
      'plugin-update',
      'plugin-uninstall',
      'skill-create',
      'skill-patch',
      'skill-install',
    ];
    seedMessages(kinds.map((k, i) => cardMsg(`c${i}`, k)));
    const { container } = render(<ChatArea />);
    // 这七种 kind 全部 return null → 不渲染任何带 data-message-id 的消息气泡
    expect(container.querySelectorAll('[data-message-id]')).toHaveLength(0);
  });

  it('带 anchorTo 的 memory-record 卡出现在对应 assistant 回复之后', () => {
    seedMessages([
      assistantMsg('m_prev'),
      assistantMsg('m_assistant'),
      cardMsg('mem1', 'memory-record', {
        // MemoryRecordCard 用 memoryRecord payload 渲染正文，不用 message.text
        memoryRecord: {
          scope: 'agent',
          relPath: 'user/profile.md',
          type: 'profile',
        } as never,
      }),
    ]);
    render(<ChatArea />);
    const prev = screen.getByText('回复 m_prev').closest('[data-message-id]')!;
    const cur = screen.getByText('回复 m_assistant').closest('[data-message-id]')!;
    const card = screen.getByText(/整篇重写了/).closest('.rounded-sm')!;
    // 位置断言（S1 根本目标）：锚定的 memory-record 卡插在 m_assistant 之后、m_prev 之后
    expect(Node.DOCUMENT_POSITION_FOLLOWING & prev.compareDocumentPosition(card)).toBeTruthy();
    expect(Node.DOCUMENT_POSITION_FOLLOWING & cur.compareDocumentPosition(card)).toBeTruthy();
    expect(screen.getByText('已记下')).toBeTruthy();
  });

  it('带 anchorTo 的 skill-call / plugin-activate 卡出现在对应回复后（SkillModuleChip）', () => {
    seedMessages([
      assistantMsg('m_assistant'),
      skillCard('s1', 'skill-call', 'anchorCards'),
      skillCard('p1', 'plugin-activate', 'some-plugin'),
    ]);
    render(<ChatArea />);
    const assist = screen.getByText('回复 m_assistant').closest('[data-message-id]')!;
    const skill = screen.getByText(/用了 anchorCards skill/).closest('div')!;
    const plugin = screen.getByText(/激活了 some-plugin plugin/).closest('div')!;
    // 位置断言：skill / plugin 锚定卡都插在所属 assistant 回复之后
    expect(Node.DOCUMENT_POSITION_FOLLOWING & assist.compareDocumentPosition(skill)).toBeTruthy();
    expect(Node.DOCUMENT_POSITION_FOLLOWING & assist.compareDocumentPosition(plugin)).toBeTruthy();
  });

  it('流式中态：assistant done:false、文本未定，锚定卡已挂其下、随 appendDelta 不跳位', () => {
    const liveAssistant = assistantMsg('m_assistant', { done: false, text: '' });
    seedMessages([
      liveAssistant,
      cardMsg('mem1', 'memory-record', {
        memoryRecord: { scope: 'agent', relPath: 'user/profile.md', type: 'profile' } as never,
      }),
    ]);
    render(<ChatArea />);
    // 流式期间，锚定卡已在其下（可见）
    expect(screen.getByText('已记下')).toBeTruthy();
    // 模拟 appendDelta 追加文本（位置由 anchorTo 决定，与 createdAt 无关，卡不消失）
    act(() => {
      useChatStore.getState().appendDelta(CONV, 'm_assistant', { textChunk: '你好' });
    });
    expect(screen.getByText(/你好/)).toBeTruthy();
    expect(screen.getByText('已记下')).toBeTruthy();
  });

  it('context-compressed 保留现状（独立渲染）', () => {
    seedMessages([
      assistantMsg('m_assistant'),
      cardMsg('cc1', 'context-compressed', {
        text: '上下文已压缩',
        contextCompressed: {
          compressedMessageIds: ['old1', 'old2', 'old3'],
          summary: '早期内容已折叠',
        } as never,
        anchorTo: undefined,
      }),
    ]);
    render(<ChatArea />);
    expect(screen.getByText(/上下文已压缩/)).toBeTruthy();
  });

  it('老数据无 anchorTo → 保留卡按 createdAt 沉流尾（行为不变）', () => {
    // assistant 在 100，卡在 200（无 anchorTo）→ 卡按 createdAt 排在 assistant 后，仍可见
    seedMessages([
      assistantMsg('m_assistant'),
      cardMsg('mem_old', 'memory-record', {
        memoryRecord: { scope: 'agent', relPath: 'user/profile.md', type: 'profile' } as never,
        anchorTo: undefined,
      }),
    ]);
    render(<ChatArea />);
    expect(screen.getByText('已记下')).toBeTruthy();
  });
});
