/**
 * 对话分组与图标——共享纯函数（对话列表 ConversationList 与定时任务的对话选择器共用一份）。
 *
 * 为什么抽出来：成员归属（活跃/归档、时间分桶）与类别图标过去内联在 ConversationList 的
 * TimeLog / ConvRow 里，picker 若另写一套，将来改了分桶边界 / 加一组 / 换图标，两端会悄悄漂走。
 * 这里是唯一事实来源——改分桶或加来源只改这里，两端自动跟随。
 */
import type { Conversation } from '@shared/types';
import { bucketOf } from './conversationBuckets';

export type ConversationGroups = {
  today: Conversation[];
  week: Conversation[];
  earlier: Conversation[];
  archived: Conversation[];
};

/**
 * 把对话分成 今天 / 本周 / 更早 / 已归档 四组。
 * - 归档（archivedAt != null）退出时间分桶，单独成「已归档」；
 * - 但「正在看的对话」（id === activeId）即便已归档也留活跃区——前端显示兜底，
 *   切走后下次渲染才真正沉入已归档（与 ConversationList 现有行为一致）。
 */
export function groupConversations(
  list: Conversation[],
  opts?: { activeId?: string | null; now?: number },
): ConversationGroups {
  const activeId = opts?.activeId ?? null;
  const now = opts?.now ?? Date.now();
  const g: ConversationGroups = { today: [], week: [], earlier: [], archived: [] };
  for (const c of list) {
    if (c.archivedAt != null && c.id !== activeId) g.archived.push(c);
    else g[bucketOf(c.updatedAt, now)].push(c);
  }
  return g;
}

// 待办浮顶（G108）已于 2026-07-19 UI/UX 改造 骨-3 拍板取消——黄点行留在原时间分区、
// 待办信号交给通知中心统一承载，故原 pinTodos 抽顶纯函数一并删除。

export type ConversationIconKind = 'normal' | 'aside' | 'platform';

/** 对话行的图标类别：随手评点=aside（星光）/ 平台来源=platform（纸飞机）/ 否则=normal（气泡）。 */
export function conversationIconKind(conv: Conversation): ConversationIconKind {
  if (conv.kind === 'aside') return 'aside';
  if (conv.source) return 'platform';
  return 'normal';
}
