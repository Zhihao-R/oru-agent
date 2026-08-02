/**
 * 「Oru 停下来等你」的统一视觉记号——8px 黄点 + 3px 淡晕圈（不变量：黄=等用户）。
 * 单一出处，供审批锚点 / 追问锚点 / 停靠面板头等处复用，避免 shadow arbitrary 三处漂移。
 */
import { cn } from '@/lib/cn';

export function PendingDot({ className }: { className?: string }) {
  return (
    <span
      className={cn('h-2 w-2 shrink-0 rounded-full bg-warn shadow-[0_0_0_3px_var(--warn-soft)]', className)}
    />
  );
}
