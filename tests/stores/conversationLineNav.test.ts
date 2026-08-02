/**
 * conversationStore 与「当前线」「持久化」的两条承重副作用：
 * - setActive / openConversationAt 收口：打开或新建对话（含 convId=null）都把当前线切到对话线，
 *   分散入口（列表点选、最近对话、搜索跳转、启动器建对话）不用各自改；
 * - activeByAgent 变化即落盘 localStorage（subscribe 收口），重启读回上次活跃对话。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';

// markSeen fire-and-forget 会打 conv.markSeen；默认 throw 被 .catch 吞，不影响本测试。
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(_p: ClientRequestPayload): Promise<T> => {
      throw new Error('ws 未配置');
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useConversationStore } from '@/stores/conversationStore';
import { useLandingNavStore } from '@/stores/landingNavStore';

const lsBack: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => lsBack[k] ?? null,
  setItem: (k: string, v: string) => {
    lsBack[k] = v;
  },
  removeItem: (k: string) => {
    delete lsBack[k];
  },
  clear: () => {
    for (const k of Object.keys(lsBack)) delete lsBack[k];
  },
} satisfies Partial<Storage>;

beforeEach(() => {
  localStorageMock.clear();
  vi.stubGlobal('window', { localStorage: localStorageMock });
  useConversationStore.setState({ byAgent: {}, activeByAgent: {}, byId: {}, archivedByAgent: {} });
  useLandingNavStore.setState({ line: 'memory', scrollRequest: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('setActive / openConversationAt 收口对话线', () => {
  it('打开已有对话（setActive convId）→ 当前线切对话线', () => {
    useConversationStore.getState().setActive('a1', 'c1');
    expect(useLandingNavStore.getState().line).toBe('chat');
  });

  it('新建对话（setActive null，清空指针）→ 也切对话线（落纯净新建页）', () => {
    useConversationStore.getState().setActive('a1', null);
    expect(useLandingNavStore.getState().line).toBe('chat');
  });

  it('搜索跳转打开对话（openConversationAt）→ 对话线', () => {
    useConversationStore.getState().openConversationAt('a1', 'c1', 'm1');
    expect(useLandingNavStore.getState().line).toBe('chat');
  });

  // 回归：从手账线点「新对话」时 HomeLanding 被复用不重挂（memory→chat 同一组件），
  // 只切线不发滚动请求的话画面纹丝不动——新建必须显式请求滚回顶部启动器。
  it('新建对话（setActive null）→ 发 requestScroll(chat) 滚回顶部启动器', () => {
    useConversationStore.getState().setActive('a1', null);
    expect(useLandingNavStore.getState().scrollRequest).toBe('chat');
  });

  it('打开已有对话（setActive convId）→ 不发滚动请求（消息流分支用不上）', () => {
    useConversationStore.getState().setActive('a1', 'c1');
    expect(useLandingNavStore.getState().scrollRequest).toBeNull();
  });
});

describe('activeByAgent 跨重启持久化（subscribe 落盘）', () => {
  it('setActive 变更活跃对话 → 写入 localStorage', () => {
    useConversationStore.getState().setActive('a1', 'c1');
    const raw = window.localStorage.getItem('oru.conv.active');
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string)).toEqual({ a1: 'c1' });
  });

  it('对话被清空（setActive null）→ 落盘为空（该 agent 键删除）', () => {
    useConversationStore.getState().setActive('a1', 'c1');
    useConversationStore.getState().setActive('a1', null);
    expect(JSON.parse(window.localStorage.getItem('oru.conv.active') as string)).toEqual({});
  });
});
