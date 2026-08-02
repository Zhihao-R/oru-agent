/**
 * 全局瞬时提示队列（M8）——写操作失败等低频瞬时反馈的唯一出口。
 *
 * 克制：单一样式、自动消失、上限 3 条不无界堆叠；不承载「重试」等交互（回滚型控件自身兜底）。
 * i18n 不进本 store——调用点传已翻译好的文案（渲染层持 t），store 只管展示，与全仓 i18n 分层一致。
 */
import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
}

/** 自动消失时长：够读一行、又不赖着不走。 */
const AUTO_DISMISS_MS = 4000;
/** 同屏上限：多于此丢最旧，避免连环失败刷屏。 */
const MAX_VISIBLE = 3;

let seq = 0;

interface ToastState {
  toasts: Toast[];
  /** 追加一条，返回其 id（供调用点需要时手动 dismiss）。 */
  show: (message: string) => number;
  dismiss: (id: number) => void;
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],
  show: (message) => {
    const id = (seq += 1);
    set((s) => ({ toasts: [...s.toasts, { id, message }].slice(-MAX_VISIBLE) }));
    setTimeout(() => get().dismiss(id), AUTO_DISMISS_MS);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
