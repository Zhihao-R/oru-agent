/**
 * 全局提示宿主（M8）——挂在 App 顶层一份，右下角堆叠 toastStore 队列。
 * 样式沿用告警三件套 border-danger / bg-danger-soft / text-danger（TaskReportCard 同款）；单一样式、克制。
 */
import { AlertCircle, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useToastStore } from '@/stores/toastStore';

export function ToastHost(): React.ReactElement | null {
  const { t } = useTranslation('common');
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[70] flex flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          role="alert"
          className="pointer-events-auto flex max-w-xs items-start gap-2 rounded-lg border border-danger bg-danger-soft px-3 py-2 text-xs text-danger shadow-soft"
        >
          <AlertCircle size={14} strokeWidth={1.5} className="mt-0.5 shrink-0" />
          <span className="flex-1 leading-snug">{toast.message}</span>
          <button
            type="button"
            onClick={() => dismiss(toast.id)}
            aria-label={t('close')}
            className="shrink-0 opacity-70 transition-opacity hover:opacity-100"
          >
            <X size={12} strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </div>
  );
}
