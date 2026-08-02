/** @vitest-environment jsdom */
/**
 * ConversationList 的来源 icon（§4.5）：平台起源的会话在列表标识来源——
 * 飞书 / Discord 会话渲染对应平台单色图标；桌面会话（无 source）维持普通图标。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
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

function conv(
  id: string,
  kind: Conversation['kind'],
  title: string,
  source?: Conversation['source'],
): Conversation {
  // updatedAt 取当下：对话栏整理后列表按时间分桶，「更早」默认折叠——用近期时间戳让会话落「今天」摊开区，才验得到来源 icon
  return { id, ownerId: 'local-user', agentId: 'a1', kind, title, sdkSessionId: null, createdAt: 1000, updatedAt: Date.now(), source };
}

const MAIN = conv('c-main', 'main', '主对话');
const FEISHU = conv('c-fs', 'sub', '豆瓣评分整理', { platform: 'feishu', chatId: 'oc_1' });
const DESKTOP = conv('c-desk', 'sub', '桌面随手对话');

beforeEach(() => {
  useAgentStore.setState({ agents: [], activeAgentId: 'a1' });
  useConversationStore.setState({
    byAgent: { a1: [MAIN, FEISHU, DESKTOP] },
    activeByAgent: { a1: MAIN.id },
    byId: { [MAIN.id]: MAIN, [FEISHU.id]: FEISHU, [DESKTOP.id]: DESKTOP },
    archivedByAgent: {},
  });
});

afterEach(cleanup);

describe('来源 icon', () => {
  it('飞书起源的会话渲染飞书来源标识；桌面会话不渲染平台标识', () => {
    const { container } = render(<ConversationList />);
    expect(container.querySelector('[data-platform="feishu"]')).toBeTruthy();
    expect(container.querySelector('[data-platform="discord"]')).toBeNull();
  });
});
