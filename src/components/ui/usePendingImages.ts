/**
 * 组件本地的待发送图片管理：原子上限校验 + blob 生命周期（含卸载清理）。
 *
 * 用于单实例输入框（如评论框，绑定单个 taskId，不需要跨对话保留草稿）。
 * 聊天侧因需"切对话再切回图还在"改用 chatStore 按 conv 分桶——状态归属不同，
 * 但上限校验复用同一个 checkCountLimit，行为一致。
 *
 * ref 镜像最新 items：让 add 的上限判断与写入在同一同步上下文里完成（避免函数式
 * setState 批处理导致的 TOCTOU），也让卸载清理能拿到最新 items 而不被空依赖闭包冻住。
 */
import { useEffect, useRef, useState } from 'react';
import {
  buildPendingAttachments,
  checkCountLimit,
  type PendingAttachment,
} from '@/lib/imageAttachments';

export function usePendingImages() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const ref = useRef<PendingAttachment[]>([]);
  ref.current = items;

  // 卸载时 revoke 仍挂在本地（未发送）的 blob；已 submit 的此时 items 已是 []，天然不误伤
  useEffect(
    () => () => {
      for (const a of ref.current) URL.revokeObjectURL(a.displayUrl);
    },
    [],
  );

  /** 校验 + 加入，返回拒绝原因（null=成功）。上限判断用 ref.current 同步算，无 TOCTOU。 */
  const add = (files: File[]): string | null => {
    const { accepted, reason } = buildPendingAttachments(files);
    if (reason) return reason;
    const over = checkCountLimit(ref.current.length, accepted);
    if (over) return over;
    const next = [...ref.current, ...accepted];
    ref.current = next;
    setItems(next);
    return null;
  };

  const remove = (id: string) => {
    const target = ref.current.find((a) => a.id === id);
    if (target) URL.revokeObjectURL(target.displayUrl);
    const next = ref.current.filter((a) => a.id !== id);
    ref.current = next;
    setItems(next);
  };

  /** 提交后清空：不 revoke——blob 交给乐观消息，后续由 applyNoteAdded 替换时释放。 */
  const clearWithoutRevoke = () => {
    ref.current = [];
    setItems([]);
  };

  /** 丢弃草稿（如 Esc）：revoke 全部 blob 后清空——这些图不会被任何消息接管。 */
  const clear = () => {
    for (const a of ref.current) URL.revokeObjectURL(a.displayUrl);
    ref.current = [];
    setItems([]);
  };

  return { items, add, remove, clear, clearWithoutRevoke };
}
