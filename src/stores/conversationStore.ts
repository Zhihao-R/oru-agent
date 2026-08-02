import { create } from 'zustand';
import type { Conversation } from '@shared/types';
import type { AsideListResultEvent, ConvStateEvent } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { useLandingNavStore } from '@/stores/landingNavStore';

type ConvStoreState = {
  byAgent: Record<string, Conversation[]>;
  activeByAgent: Record<string, string>;
  /** 按 conv id 反查的索引；含所有 kind（含 'taskboard-comment'，给 PR-D 评论 conv 用）。
   *  syncForAgent 同步写入；registerConversation 单条写入（不进 byAgent，避免污染列表）；
   *  remove 同步清理。 */
  byId: Record<string, Conversation>;
  /** 归档的随手评点（kind:'aside'）对话，按 agent 分桶。展开「已归档」分组时经
   *  aside.list 按需拉取；不进 byAgent、不参与 active 计算（与 conv.state 两种语义）。 */
  archivedByAgent: Record<string, Conversation[]>;

  /**
   * 搜索命中跳转点亮：点搜索结果某条消息 → 记下要点亮的 (agent, conv, message)，
   * 切到该对话后 ChatArea 滚到那条消息、闪一下，然后清空。null = 无待点亮。
   */
  flashTarget: { agentId: string; convId: string; messageId: string } | null;

  syncForAgent: (agentId: string, list: Conversation[]) => void;
  /** 单条注册到 byId 不进 byAgent。PR-D 监听 taskboard.commentConvCreated 用。 */
  registerConversation: (conv: Conversation) => void;
  /** convId=null 回到草稿态（主对话已取消，无对话即一张干净的新对话界面） */
  setActive: (agentId: string, convId: string | null) => void;
  /** 切到某对话并标记跳转点亮的消息（搜索命中用） */
  openConversationAt: (agentId: string, convId: string, messageId: string) => void;
  /** 打开对话即标记已读（通知中心 §5.1）：乐观拍 lastSeenAt + fire-and-forget 落盘。 */
  markSeen: (agentId: string, convId: string) => void;
  clearFlashTarget: () => void;
  /** 获取某 agent 当前 active 的 conversation id；null = 草稿态（不再回落主对话/首项） */
  getActiveConvId: (agentId: string) => string | null;
  refresh: (agentId: string) => Promise<void>;
  /** 拉取归档 aside 列表（每次展开都拉，简单正确）；结果项注册进 byId——
   *  syncForAgent 的 aside 豁免靠查 byId[active].kind，从归档打开必须先有它。 */
  fetchArchived: (agentId: string) => Promise<void>;
  /** promote 后发起方本地移除：归档分组数据按需拉取，没有广播管它。 */
  removeArchived: (agentId: string, convId: string) => void;
  create: (agentId: string, title: string) => Promise<Conversation | null>;
  rename: (agentId: string, convId: string, title: string) => Promise<void>;
  /** 手动归档：收进「已归档」抽屉（可恢复）。对话仍在列表、只多 archivedAt，走重分桶。 */
  archive: (agentId: string, convId: string) => Promise<void>;
  /** 彻底删除：从索引移除、历史落 .bak（不可在应用内恢复）。即原 conv.delete 硬删。 */
  remove: (agentId: string, convId: string) => Promise<void>;
  clear: (agentId: string, convId: string) => Promise<void>;
};

function indexByIdFromList(list: Conversation[]): Record<string, Conversation> {
  const out: Record<string, Conversation> = {};
  for (const c of list) out[c.id] = c;
  return out;
}

/**
 * conv.state 同步后的 active 取舍：
 * - 仍在列表 → 保留；
 * - active 是 aside 对话 → 也保留——aside 结构性缺席 conv.state 列表（sub 全量），
 *   不代表它被删了；不豁免则阅读归档评点期间，后台任何一轮对话结束的广播都会把视图拽走；
 * - 否则回落草稿态（null）。主对话已取消，不再自动选中首项——"新开为主"，想接着上次聊
 *   就点列表第一条。
 * byId 传调用方语境下的最新索引（remove 传删除后的 nextById——被删的 aside 不该再豁免）。
 */
function nextActiveAfterSync(
  currentActive: string | undefined,
  list: Conversation[],
  byId: Record<string, Conversation>,
): string | null {
  if (currentActive) {
    if (list.some((c) => c.id === currentActive)) return currentActive;
    if (byId[currentActive]?.kind === 'aside') return currentActive;
  }
  return null;
}

/**
 * 打开对话即标记已读（通知中心 §5.1）——乐观把该 conv 的 lastSeenAt 拍到当下，让通知中心
 * 「已完成」段与列表 unread 标记立即清掉；同时 fire-and-forget 落盘（失败不回滚，值随下次 conv.state 同步）。
 * 统一入口：开门盖章走 setActive / openConversationAt（点击=打开对话）；停留期间随对话更新持续推进
 * 走 useMarkDisplayedConvSeen。两条都只调这一个 markSeen，后端水位只升不降、重复盖章幂等。
 */
function patchSeen(
  byAgent: Record<string, Conversation[]>,
  byId: Record<string, Conversation>,
  agentId: string,
  convId: string,
  seenAt: number,
): { byAgent: Record<string, Conversation[]>; byId: Record<string, Conversation> } {
  const mark = (c: Conversation): Conversation =>
    c.id === convId ? { ...c, lastSeenAt: seenAt } : c;
  return {
    byAgent: { ...byAgent, [agentId]: (byAgent[agentId] ?? []).map(mark) },
    byId: byId[convId] ? { ...byId, [convId]: { ...byId[convId], lastSeenAt: seenAt } } : byId,
  };
}

/** 把 newActive 写进 activeByAgent；null 时删除该 agent 的键（= 回到草稿态） */
function withActive(
  activeByAgent: Record<string, string>,
  agentId: string,
  newActive: string | null,
): Record<string, string> {
  const next = { ...activeByAgent };
  if (newActive) next[agentId] = newActive;
  else delete next[agentId];
  return next;
}

/** 只持久化「上次活跃对话」到 localStorage（renderer UI 态，不入后端 settings）。byAgent/byId 等
 *  易失大态不存，重启由 refresh 重新同步；line 不存，冷启动恒手账线。 */
const ACTIVE_STORAGE_KEY = 'oru.conv.active';
function loadActive(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(ACTIVE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}
function saveActive(activeByAgent: Record<string, string>): void {
  try {
    window.localStorage.setItem(ACTIVE_STORAGE_KEY, JSON.stringify(activeByAgent));
  } catch {
    // 忽略 quota / 隐身模式
  }
}

export const useConversationStore = create<ConvStoreState>((set, get) => ({
  byAgent: {},
  activeByAgent: loadActive(),
  byId: {},
  archivedByAgent: {},
  flashTarget: null,
  syncForAgent: (agentId, list) => {
    set((s) => {
      const newActive = nextActiveAfterSync(s.activeByAgent[agentId], list, s.byId);
      return {
        byAgent: { ...s.byAgent, [agentId]: list },
        activeByAgent: withActive(s.activeByAgent, agentId, newActive),
        byId: { ...s.byId, ...indexByIdFromList(list) },
      };
    });
  },
  registerConversation: (conv) => {
    set((s) => ({ byId: { ...s.byId, [conv.id]: conv } }));
  },
  setActive: (agentId, convId) => {
    if (convId) get().markSeen(agentId, convId);
    set((s) => ({
      activeByAgent: withActive(s.activeByAgent, agentId, convId),
      // 切对话即清掉待点亮（普通切换不是搜索跳转）
      flashTarget: null,
    }));
    // 打开或新建对话都走这里（列表点选、最近对话、启动器建对话、convId=null 新建）——一处收口把
    // 当前线切到对话线，分散入口不用各自改。手账被删导致的回落走 syncForAgent/withActive、不经此，故不动线。
    useLandingNavStore.getState().setLine('chat');
    // 新建（convId=null）：着陆面可能因 line 未变（本就在 chat）或组件复用（memory→chat 同为
    // HomeLanding）而不重挂、滚动原地不动——显式请求滚回顶部启动器，HomeLanding 消费即清。
    if (!convId) useLandingNavStore.getState().requestScroll('chat');
  },
  openConversationAt: (agentId, convId, messageId) => {
    get().markSeen(agentId, convId);
    set((s) => ({
      activeByAgent: withActive(s.activeByAgent, agentId, convId),
      flashTarget: { agentId, convId, messageId },
    }));
    useLandingNavStore.getState().setLine('chat'); // 搜索跳转打开对话 → 对话线
  },
  markSeen: (agentId, convId) => {
    const seenAt = Date.now();
    set((s) => patchSeen(s.byAgent, s.byId, agentId, convId, seenAt));
    // fire-and-forget 落盘：失败不回滚（乐观值已生效），值随下次 conv.state 同步
    void wsClient
      .request({ type: 'conv.markSeen', agentId, conversationId: convId, seenAt })
      .catch(() => undefined);
  },
  clearFlashTarget: () => set({ flashTarget: null }),
  getActiveConvId: (agentId) => get().activeByAgent[agentId] ?? null,
  async refresh(agentId) {
    try {
      const res = await wsClient.request<ConvStateEvent>({ type: 'conv.list', agentId });
      if (res.type === 'conv.state') get().syncForAgent(agentId, res.conversations);
    } catch {
      // ignore
    }
  },
  async fetchArchived(agentId) {
    try {
      const res = await wsClient.request<AsideListResultEvent>({ type: 'aside.list', agentId });
      if (res.type !== 'aside.list.result') return;
      // 只动归档分桶与 byId（豁免与 chat 事件路由都查它）——不冲 byAgent 主列表、不动 active
      set((s) => ({
        archivedByAgent: { ...s.archivedByAgent, [agentId]: res.conversations },
        byId: { ...s.byId, ...indexByIdFromList(res.conversations) },
      }));
    } catch {
      // ignore（与 refresh 同口径：拉取失败保持现状）
    }
  },
  removeArchived(agentId, convId) {
    set((s) => ({
      archivedByAgent: {
        ...s.archivedByAgent,
        [agentId]: (s.archivedByAgent[agentId] ?? []).filter((c) => c.id !== convId),
      },
    }));
  },
  async create(agentId, title) {
    // 用 ID 差集挑刚创建的 sub——不能靠"updatedAt desc 排首位"，因为后台 autoName
    // rename 也会刷 updatedAt，create 完到 rename 落盘之间的窗口里，subs[0] 可能是
    // 刚被命名的旧 sub，setActive 会跑到错对话。
    const before = new Set(
      (get().byAgent[agentId] ?? []).filter((c) => c.kind === 'sub').map((c) => c.id),
    );
    try {
      const res = await wsClient.request<ConvStateEvent>({
        type: 'conv.create',
        agentId,
        title,
      });
      if (res.type === 'conv.state') {
        get().syncForAgent(agentId, res.conversations);
        const created = res.conversations.find(
          (c) => c.kind === 'sub' && !before.has(c.id),
        );
        return created ?? null;
      }
      return null;
    } catch {
      return null;
    }
  },
  async rename(agentId, convId, title) {
    try {
      const res = await wsClient.request<ConvStateEvent>({
        type: 'conv.rename',
        agentId,
        conversationId: convId,
        title,
      });
      if (res.type === 'conv.state') get().syncForAgent(agentId, res.conversations);
    } catch {
      // ignore
    }
  },
  async archive(agentId, convId) {
    try {
      const res = await wsClient.request<ConvStateEvent>({
        type: 'conv.archive',
        agentId,
        conversationId: convId,
      });
      // 归档不删条目（只多 archivedAt）：syncForAgent 重分桶即把它挪进「已归档」。
      if (res.type === 'conv.state') get().syncForAgent(agentId, res.conversations);
      // 归档的正是当前打开的对话 → 清空选中、落新建对话页（activeId 豁免会让它继续赖在
      // 活跃区、界面零变化，读作「点了没反应」；跳走后豁免自然失效，下次渲染沉入归档区）。
      // await 后重读再判：等待期间用户可能已切走，别把人家新开的对话也清掉。
      if (get().activeByAgent[agentId] === convId) get().setActive(agentId, null);
    } catch {
      // ignore
    }
  },
  async remove(agentId, convId) {
    try {
      const res = await wsClient.request<ConvStateEvent>({
        type: 'conv.delete',
        agentId,
        conversationId: convId,
      });
      if (res.type === 'conv.state') {
        // syncForAgent 和 byId 删除合并到一次 set，避免外部 selector 在两次 set 之间
        // 看到 byAgent 已无该 conv 但 byId 仍残留的瞬态
        set((s) => {
          const list = res.conversations;
          const nextById: Record<string, Conversation> = { ...s.byId };
          for (const c of list) nextById[c.id] = c;
          delete nextById[convId];
          // active 取舍传删除后的 nextById：正在阅读的 aside 不被"删了别的对话"拽走，
          // 被删的恰是该 aside 时豁免自然失效、照常回落主对话
          const newActive = nextActiveAfterSync(s.activeByAgent[agentId], list, nextById);
          return {
            byAgent: { ...s.byAgent, [agentId]: list },
            activeByAgent: withActive(s.activeByAgent, agentId, newActive),
            byId: nextById,
          };
        });
      }
    } catch {
      // ignore
    }
  },
  async clear(agentId, convId) {
    try {
      const res = await wsClient.request<ConvStateEvent>({
        type: 'conv.clear',
        agentId,
        conversationId: convId,
      });
      if (res.type === 'conv.state') get().syncForAgent(agentId, res.conversations);
    } catch {
      // ignore
    }
  },
}));

// 「上次活跃对话」变化即落盘（含 setActive / syncForAgent 校验回落 / remove）——一处订阅收口，
// 重启由初始 loadActive() 读回，再经 syncForAgent 的 nextActiveAfterSync 二次校验（对话没了则回落）。
useConversationStore.subscribe((s, prev) => {
  if (s.activeByAgent !== prev.activeByAgent) saveActive(s.activeByAgent);
});
