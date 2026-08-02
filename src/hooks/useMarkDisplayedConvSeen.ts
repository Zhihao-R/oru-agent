import { useLayoutEffect } from 'react';
import { useConversationStore } from '@/stores/conversationStore';

/**
 * 显示中的对话在你眼前更新（含 Oru 输出完成刷新 updatedAt）时，把已读水位跟上去（通知中心 §5.1 补缺）。
 *
 * 缺口：lastSeenAt 原本只在「打开对话那一刻」盖章，之后不动。人停在对话里看着 Oru 把活干完时，
 * 后端把 updatedAt 顶过水位 → 判未读 → 误进「已完成（待验收）」（判定见 conversationStatus.isUnread）。
 * 只影响 done→未读 一路；「需要处理」类 badge 不看 lastSeenAt，不会被误隐藏。
 *
 * 用 useLayoutEffect：完成跃迁的那一帧 paint 前就盖好章，否则列表黄点会先闪一下旧的「待验收」。
 * updatedAt 由后端在同机（Electron 主进程）盖，与客户端 markSeen 的 Date.now() 无时钟偏移。
 *
 * 承重契约（反向锚点，勿动）：本 hook **只为显示中（active）的那条对话**盖章——调用点
 * ChatArea 只传 activeConvId，没在看的对话永不经过这里。中断按停半截落盘会顶高对话 updatedAt
 * （runChatAndPersist 的 onInterruptedPersisted 推 conv.state，见其头注释），「对话内按停不留未读 /
 * 提醒中心按停另一条对话仍未读」这一两入口区分**全靠**本 hook 的 active-only 盖章天然实现，
 * 无需后端给 chat.abort 加 source。若改成为所有对话盖章、或放宽 active 判定，会静默破坏
 * 「提醒中心按停仍 unread」——回归见 tests/hooks/useMarkDisplayedConvSeen.test.ts。
 */
export function useMarkDisplayedConvSeen(
  agentId: string | null,
  convId: string | null,
  updatedAt: number | undefined,
): void {
  const markSeen = useConversationStore((s) => s.markSeen);
  useLayoutEffect(() => {
    if (agentId && convId) markSeen(agentId, convId);
    // updatedAt 进 deps：对话每次更新就重新盖章
  }, [agentId, convId, updatedAt, markSeen]);
}
