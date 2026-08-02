/** @vitest-environment jsdom */
/**
 * ConversationList 的「活跃 / 已归档」两大区（对话归档）：
 * - 活跃区按今天/本周/更早分段；「更早」只装早于本周、未归档的普通对话（不再混随手评点）。
 * - 「已归档」独立抽屉：archivedAt 非空的普通对话 + 全部随手评点（aside），进列表即拉 aside.list。
 * - 「正在看的对话」即便已归档也留在活跃区（前端显示兜底），不进已归档抽屉。
 * - 折叠态归档项不渲染；展开后出现，响应不冲主列表、不动 active、结果项注册 byId（豁免前提）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { Conversation } from '@shared/types';

const ws = vi.hoisted(() => ({
  impl: (async (_p: ClientRequestPayload): Promise<ServerEventPayload> => {
    throw new Error('ws.impl 未配置');
  }) as (p: ClientRequestPayload) => Promise<ServerEventPayload>,
  calls: [] as ClientRequestPayload[],
}));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> => {
      ws.calls.push(payload);
      return (await ws.impl(payload)) as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { ConversationList } from '@/components/ConversationList';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';

function conv(
  id: string,
  kind: Conversation['kind'],
  title: string,
  updatedAt = 1000,
  archivedAt?: number,
): Conversation {
  return {
    id,
    ownerId: 'local-user',
    agentId: 'a1',
    kind,
    title,
    sdkSessionId: null,
    createdAt: 1000,
    updatedAt,
    archivedAt,
  };
}

// 主列表（byAgent，全量 sub 含归档）：一条活跃今天对话 + 一条已归档的旧 sub；ASIDE 经 aside.list 拉
const TODAY = conv('c-today', 'sub', '今天的对话', Date.now());
const ARCHIVED_SUB = conv('c-arch', 'sub', '归档的旧对话', 1000, 5000);
const ASIDE = conv('c-aside', 'aside', '这页配色', 1000);

beforeEach(() => {
  ws.calls = [];
  ws.impl = async (p) => {
    if (p.type === 'aside.list') {
      return { type: 'aside.list.result', agentId: 'a1', conversations: [ASIDE] };
    }
    throw new Error(`未预期的请求：${p.type}`);
  };
  useAgentStore.setState({ agents: [], activeAgentId: 'a1' });
  useConversationStore.setState({
    byAgent: { a1: [TODAY, ARCHIVED_SUB] },
    activeByAgent: { a1: TODAY.id },
    byId: { [TODAY.id]: TODAY, [ARCHIVED_SUB.id]: ARCHIVED_SUB },
    archivedByAgent: {},
  });
});

afterEach(cleanup);

describe('已归档抽屉', () => {
  it('进列表即拉 aside.list；折叠态归档项不渲染；展开「已归档」后归档 sub + 随手评点都出现，且不冲主列表/不动 active/注册 byId', async () => {
    render(<ConversationList />);
    await waitFor(() => expect(ws.calls.some((c) => c.type === 'aside.list')).toBe(true));

    // 折叠态：归档项（aside + 归档 sub）都不渲染；活跃的今天对话照常在
    expect(screen.queryByText('这页配色')).toBeNull();
    expect(screen.queryByText('归档的旧对话')).toBeNull();
    expect(screen.getByText('今天的对话')).toBeTruthy();

    fireEvent.click(await screen.findByRole('button', { name: /已归档/ }));
    await waitFor(() => expect(screen.getByText('这页配色')).toBeTruthy());
    expect(screen.getByText('归档的旧对话')).toBeTruthy();

    const now = useConversationStore.getState();
    expect(now.byAgent['a1']).toEqual([TODAY, ARCHIVED_SUB]); // 不冲主列表
    expect(now.activeByAgent['a1']).toBe(TODAY.id); // 不动 active
    expect(now.byId[ASIDE.id]).toEqual(ASIDE); // aside 注册 byId（豁免前提）
  });

  it('点击随手评点项 → 设为 active（切到 ChatArea 阅读的入口）', async () => {
    render(<ConversationList />);
    fireEvent.click(await screen.findByRole('button', { name: /已归档/ }));
    const item = await screen.findByText('这页配色');
    fireEvent.click(item);
    expect(useConversationStore.getState().activeByAgent['a1']).toBe(ASIDE.id);
  });

  it('正在看的对话即便已归档也留在活跃区，不进已归档抽屉（前端显示兜底）', async () => {
    // 本例聚焦 active 豁免：清掉随手评点干扰，已归档抽屉的有无只由 archivedSubs 决定
    ws.impl = async (p) => {
      if (p.type === 'aside.list') {
        return { type: 'aside.list.result', agentId: 'a1', conversations: [] };
      }
      throw new Error(`未预期的请求：${p.type}`);
    };
    // ARCHIVED_SUB 设为 active：archivedAt 非空但因 active 豁免，仍归活跃区（updatedAt 旧 → 落「更早」）
    useConversationStore.setState({
      byAgent: { a1: [ARCHIVED_SUB] },
      activeByAgent: { a1: ARCHIVED_SUB.id },
      byId: { [ARCHIVED_SUB.id]: ARCHIVED_SUB },
      archivedByAgent: {},
    });
    render(<ConversationList />);

    fireEvent.click(await screen.findByRole('button', { name: /更早/ }));
    expect(screen.getByText('归档的旧对话')).toBeTruthy();
    // 无归档项（active 豁免 + 无 aside）→ 不出现「已归档」抽屉
    expect(screen.queryByRole('button', { name: /已归档/ })).toBeNull();
  });
});
