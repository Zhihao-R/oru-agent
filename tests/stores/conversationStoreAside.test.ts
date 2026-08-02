/**
 * conversationStore 的 aside（随手评点）集成面：
 * - syncForAgent 的 aside active 豁免——阅读归档评点期间，后台广播 conv.state
 *   （sub 全量，结构性不含 aside）不把视图拽走；
 *   反面：active 是已删除的普通对话回落草稿态（主对话已取消，不再回落首项；豁免不误伤）；
 *   前提：豁免查 byId[active].kind，aside 必须已注册 byId（begin / fetchArchived 两路）。
 * - fetchArchived：经 aside.list 拉取、结果项注册 byId、不冲 byAgent 主列表、不动 active。
 * - removeArchived：promote 后发起方本地剔除（该分组按需拉取，没有广播管它）。
 * - remove：删别的对话时 active aside 不被拽走；nextById 已删项不再豁免。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

import { useConversationStore } from '@/stores/conversationStore';

function conv(id: string, kind: Conversation['kind'], title = id): Conversation {
  return {
    id,
    ownerId: 'local-user',
    agentId: 'a1',
    kind,
    title,
    sdkSessionId: null,
    createdAt: 1000,
    updatedAt: 1000,
  };
}

// 主对话已取消——C0 只是一条普通 sub，留在列表里当"删别的不被拽走"的参照物
const C0 = conv('c0', 'sub');
const SUB = conv('c-sub', 'sub');
const ASIDE = conv('c-aside', 'aside', '一处空白');

beforeEach(() => {
  ws.calls = [];
  useConversationStore.setState({ byAgent: {}, activeByAgent: {}, byId: {}, archivedByAgent: {} });
});

describe('syncForAgent 的 aside active 豁免', () => {
  it('active 为已注册 byId 的 aside 时，conv.state 整体替换不重置 active（阅读归档不被拽回）', () => {
    const s = useConversationStore.getState();
    s.registerConversation(ASIDE);
    s.setActive('a1', ASIDE.id);
    // 后台一轮对话结束触发的广播：sub 全量，结构性不含 aside
    s.syncForAgent('a1', [C0, SUB]);
    expect(useConversationStore.getState().activeByAgent['a1']).toBe(ASIDE.id);
    // 主列表照常整体替换
    expect(useConversationStore.getState().byAgent['a1']).toEqual([C0, SUB]);
  });

  it('反面：active 是已删除的普通 sub → 回落草稿态（主对话取消后不再回落首项；豁免不误伤）', () => {
    const s = useConversationStore.getState();
    s.syncForAgent('a1', [C0, SUB]);
    s.setActive('a1', SUB.id);
    s.syncForAgent('a1', [C0]); // sub 被删后的全量
    expect(useConversationStore.getState().activeByAgent['a1']).toBeUndefined();
  });

  it('active 是未注册 byId 的 id → 不豁免、回落草稿态（豁免严格依赖注册）', () => {
    const s = useConversationStore.getState();
    s.setActive('a1', 'c-ghost');
    s.syncForAgent('a1', [C0]);
    expect(useConversationStore.getState().activeByAgent['a1']).toBeUndefined();
  });
});

describe('fetchArchived / removeArchived', () => {
  it('经 aside.list 拉取；结果注册 byId；不冲 byAgent 主列表、不动 active', async () => {
    const s = useConversationStore.getState();
    s.syncForAgent('a1', [C0, SUB]);
    s.setActive('a1', SUB.id);
    // 打开对话会 fire-and-forget conv.markSeen（通知中心已读水位）——属 setActive 的既定副作用，
    // 与本用例（fetchArchived 行为）无关，清掉这点 setup 噪声再断言。
    ws.calls = [];
    ws.impl = async (p) => {
      if (p.type === 'aside.list') {
        return { type: 'aside.list.result', agentId: 'a1', conversations: [ASIDE] };
      }
      throw new Error(`未预期的请求：${p.type}`);
    };

    await s.fetchArchived('a1');

    const now = useConversationStore.getState();
    expect(ws.calls).toEqual([{ type: 'aside.list', agentId: 'a1' }]);
    expect(now.archivedByAgent['a1']).toEqual([ASIDE]);
    // 归档项已注册 byId——syncForAgent 豁免在"读归档"主场景生效的前提
    expect(now.byId[ASIDE.id]).toEqual(ASIDE);
    // aside 不进主列表、active 不动（SUB 因被 setActive 打开已带 lastSeenAt，故比 id 不比整对象）
    expect(now.byAgent['a1'].map((c) => c.id)).toEqual([C0.id, SUB.id]);
    expect(now.activeByAgent['a1']).toBe(SUB.id);
  });

  it('removeArchived：promote 后本地剔除该项，其余保留', () => {
    const other = conv('c-aside-2', 'aside');
    useConversationStore.setState({ archivedByAgent: { a1: [ASIDE, other] } });
    useConversationStore.getState().removeArchived('a1', ASIDE.id);
    expect(useConversationStore.getState().archivedByAgent['a1']).toEqual([other]);
  });
});

describe('remove 的 active 取舍（与 syncForAgent 同一豁免口径）', () => {
  it('阅读 aside 期间删除别的对话 → active 不被拽走', async () => {
    const s = useConversationStore.getState();
    s.syncForAgent('a1', [C0, SUB]);
    s.registerConversation(ASIDE);
    s.setActive('a1', ASIDE.id);
    ws.impl = async (p) => {
      if (p.type === 'conv.delete') {
        return { type: 'conv.state', agentId: 'a1', conversations: [C0] };
      }
      throw new Error(`未预期的请求：${p.type}`);
    };

    await s.remove('a1', SUB.id);

    const now = useConversationStore.getState();
    expect(now.activeByAgent['a1']).toBe(ASIDE.id);
    expect(now.byId[SUB.id]).toBeUndefined(); // 被删项 byId 照常清理
  });
});
