/**
 * 通知中心「忽略」的前端隐藏水位（技术设计 §5.2）。
 *
 * 承重约束：未终态通知（pending proposal / awaiting 问题）的「忽略」**绝不**走 proposal.discard
 * （那是后端 delete、绕过 lifecycle、会挂起仍在等的那一轮）——只在前端隐藏。这里就是那个"前端隐藏"，
 * 不碰任何后端实体。语义与 lastSeenAt 同构：`dismissedAt[convId] >= updatedAt` 即隐藏；对话再有新动静
 * （updatedAt 超过水位）自动复现。会话级、不持久化（刷新即复位，符合"前端隐藏"定位）。
 */
import { create } from 'zustand';

type NotificationStoreState = {
  /** 按 conversationId 的忽略时刻水位 */
  dismissedAt: Record<string, number>;
  /** 忽略某条通知（拍当下水位）；对话后续有新动静即自动复现 */
  dismiss: (convId: string) => void;
};

export const useNotificationStore = create<NotificationStoreState>((set) => ({
  dismissedAt: {},
  dismiss: (convId) =>
    set((s) => ({ dismissedAt: { ...s.dismissedAt, [convId]: Date.now() } })),
}));

/** 是否被忽略且未被新动静复现：dismissedAt 不早于 updatedAt 即隐藏 */
export function isDismissed(
  dismissedAt: Record<string, number>,
  convId: string,
  updatedAt: number,
): boolean {
  const at = dismissedAt[convId];
  return at !== undefined && at >= updatedAt;
}
