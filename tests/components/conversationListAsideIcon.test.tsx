/** @vitest-environment jsdom */
/**
 * 随手评点（aside）的来源 icon：在「更早」收纳区展开后，随手评点用星光图标（单颗四芒星）
 * 标识来源，不再挂文字徽章「随手评点」——来源统一靠图标，与平台来源 icon 同一规范。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { Conversation } from '@shared/types';

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(_p: ClientRequestPayload): Promise<T> => {
      throw new Error('本用例不应发请求');
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { ConversationList } from '@/components/ConversationList';
import { useAgentStore } from '@/stores/agentStore';
import { useConversationStore } from '@/stores/conversationStore';

const ASIDE: Conversation = {
  id: 'c-aside',
  ownerId: 'local-user',
  agentId: 'a1',
  kind: 'aside',
  title: '随手评点了首页文案',
  sdkSessionId: null,
  createdAt: 1000,
  updatedAt: 2000,
};

beforeEach(() => {
  useAgentStore.setState({ agents: [], activeAgentId: 'a1' });
  useConversationStore.setState({
    byAgent: { a1: [] },
    activeByAgent: {},
    byId: { [ASIDE.id]: ASIDE },
    archivedByAgent: { a1: [ASIDE] },
    // 收纳区 mount/展开会拉一次随手评点；本用例直接喂 archivedByAgent，把拉取置空避免发请求
    fetchArchived: async () => {},
  });
});

afterEach(cleanup);

describe('随手评点来源 icon', () => {
  it('展开「已归档」后随手评点渲染星光图标，且不再有文字徽章', async () => {
    const { container } = render(<ConversationList />);
    // 收纳区默认折叠，点开「已归档」才渲染随手评点行
    fireEvent.click(await screen.findByRole('button', { name: /已归档/ }));
    expect(container.querySelector('.lucide-sparkle')).toBeTruthy();
    expect(screen.queryByText('随手评点')).toBeNull();
  });
});
