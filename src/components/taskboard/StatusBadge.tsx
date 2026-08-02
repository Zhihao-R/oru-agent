/**
 * 任务状态徽章：4 种状态各对应一个图标 + tone 颜色。
 * - 待办：空心圆，灰
 * - 进行中：半填充，accent 色
 * - 待验收：圆+点，warning 色
 * - 已完成：勾，success 色
 *
 * clickable=true 时按按钮渲染（点状态图标 → 弹 StatusMenu）。
 */
import { forwardRef, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { Circle, CircleDot, CircleEllipsis, CheckCircle2 } from 'lucide-react';
import type { BoardTaskStatus } from '@shared/types';
import { cn } from '@/lib/cn';
import { statusLabel } from './statusLabel';

// status 值即中文枚举（数据），仅持图标/色；显示 label 经 statusLabel() 取 i18n
const META: Record<BoardTaskStatus, { Icon: typeof Circle; tone: string }> = {
  '待办': { Icon: Circle, tone: 'text-text-tertiary' },
  '进行中': { Icon: CircleDot, tone: 'text-accent' },
  '待验收': { Icon: CircleEllipsis, tone: 'text-warn' },
  '已完成': { Icon: CheckCircle2, tone: 'text-success' },
};

export type StatusBadgeProps = {
  status: BoardTaskStatus;
  size?: number;
  clickable?: boolean;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  showLabel?: boolean;
  className?: string;
};

export const StatusBadge = forwardRef(function StatusBadge(
  { status, size = 16, clickable, onClick, showLabel, className }: StatusBadgeProps,
  ref: Ref<HTMLButtonElement | HTMLSpanElement>,
) {
  const { t } = useTranslation('taskboard');
  const { Icon, tone } = META[status];
  const label = statusLabel(status, t);
  if (clickable) {
    return (
      <button
        ref={ref as Ref<HTMLButtonElement>}
        type="button"
        onClick={onClick}
        title={t('statusBadge.tooltipClickable', { label })}
        aria-label={t('statusBadge.tooltipClickable', { label })}
        className={cn(
          'inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-hover',
          tone,
          className,
        )}
      >
        <Icon size={size} strokeWidth={1.5} />
      </button>
    );
  }
  return (
    <span
      ref={ref as Ref<HTMLSpanElement>}
      className={cn('inline-flex items-center gap-1.5', tone, className)}
      title={t('statusBadge.tooltip', { label })}
    >
      <Icon size={size} strokeWidth={1.5} />
      {showLabel ? <span className="text-xs">{label}</span> : null}
    </span>
  );
});
