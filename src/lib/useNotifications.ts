/**
 * 通知中心 / oru 角标 / 对话列表三处共用的状态消费 hook——都从 conversationStatus 的单一判定
 * （collectConvFacts → effectiveBadge）派生，零重复计算、口径完全一致。
 *
 * "忽略"在三处一起生效（effectiveBadge 统一施加）：绝不出现"角标归零但列表黄点还亮、proposal 仍卡着"
 * 这种自相矛盾——「中心需要你处理的集合 == 列表黄点的集合」是 PRD 反复强调的承重不变量。
 */
import { useMemo } from 'react';
import type { Conversation } from '@shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { isDismissed, useNotificationStore } from '@/stores/notificationStore';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';
import {
  buildMissedByConv,
  collectConvFacts,
  deriveConvState,
  effectiveBadge,
  groupTasksByConv,
  type ConvBadge,
  type ConvState,
} from './conversationStatus';

/** 一条对话在通知中心的聚合视图——段落由 badge 决定，段内细节由 state 选 */
export type NotifItem = {
  conv: Conversation;
  state: ConvState;
  badge: Exclude<ConvBadge, 'none'>;
  updatedAt: number;
};

const EMPTY_CONVS: Conversation[] = [];

/** 当前分身全部活跃对话过判定，产出 badge!=none 的条目（已施"忽略"，三处共用此一份）。 */
function useConvItems(agentId: string | null): NotifItem[] {
  const convs = useConversationStore((s) =>
    agentId ? s.byAgent[agentId] ?? EMPTY_CONVS : EMPTY_CONVS,
  );
  const convById = useConversationStore((s) => s.byId);
  const streamingMessageIdByConv = useChatStore((s) => s.streamingMessageIdByConv);
  const messagesByConv = useChatStore((s) => s.conversations);
  const proposalsByConv = useTaskStore((s) => s.proposalsByConv);
  const tasks = useTaskStore((s) => s.tasks);
  const dismissedAt = useNotificationStore((s) => s.dismissedAt);
  const scheduledTasks = useScheduledTaskStore((s) => s.tasks);

  const tasksByConv = useMemo(() => groupTasksByConv(tasks), [tasks]);
  // G53：错过的定时任务绑定的对话进「需要你处理」——占位转真值（映射逻辑在 conversationStatus 纯函数里）
  const missedByConv = useMemo(() => buildMissedByConv(scheduledTasks), [scheduledTasks]);

  return useMemo(() => {
    const items: NotifItem[] = [];
    for (const conv of convs) {
      const facts = collectConvFacts(conv.id, {
        streamingMessageIdByConv,
        proposalsByConv,
        tasksByConv,
        messagesByConv,
        convById,
        missedByConv,
      });
      const badge = effectiveBadge(facts, isDismissed(dismissedAt, conv.id, facts.updatedAt));
      if (badge === 'none') continue;
      items.push({ conv, state: deriveConvState(facts), badge, updatedAt: facts.updatedAt });
    }
    return items;
  }, [convs, streamingMessageIdByConv, proposalsByConv, tasksByConv, messagesByConv, convById, missedByConv, dismissedAt]);
}

/** 对话列表标记：convId → 有效 badge */
export function useConvBadges(agentId: string | null): Record<string, ConvBadge> {
  const items = useConvItems(agentId);
  return useMemo(() => {
    const m: Record<string, ConvBadge> = {};
    for (const it of items) m[it.conv.id] = it.badge;
    return m;
  }, [items]);
}

/** 通知中心三段 + 角标：需要你处理(todo) / 已完成(unread) / 进行中(running)，段内时间倒序 */
export function useNotificationItems(agentId: string | null): {
  needAction: NotifItem[];
  done: NotifItem[];
  running: NotifItem[];
} {
  const items = useConvItems(agentId);
  return useMemo(() => {
    const needAction: NotifItem[] = [];
    const done: NotifItem[] = [];
    const running: NotifItem[] = [];
    for (const it of items) {
      if (it.badge === 'todo') needAction.push(it);
      else if (it.badge === 'unread') done.push(it);
      else running.push(it);
    }
    const byRecency = (a: NotifItem, b: NotifItem) => b.updatedAt - a.updatedAt;
    return {
      needAction: needAction.sort(byRecency),
      done: done.sort(byRecency),
      running: running.sort(byRecency),
    };
  }, [items]);
}
