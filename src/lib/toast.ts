/**
 * 写操作失败等瞬时提示的便捷入口（M8）。
 * 调用点传**已翻译好的**文案（渲染层 `useTranslation` 的 t()）——store 与 i18n 解耦、与全仓分层一致。
 */
import { useToastStore } from '@/stores/toastStore';

/** 写操作失败提示：一行文案、右下角瞬时浮现、自动消失。 */
export function toastError(message: string): void {
  useToastStore.getState().show(message);
}
