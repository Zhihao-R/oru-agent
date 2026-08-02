/**
 * icon-only 按钮——hover 上 accent 色 + 浅底。
 * 用 `aria-label` 必填来防止 a11y 漏 label。
 */
import { cn } from '@/lib/cn';
import type { MouseEvent, ReactNode } from 'react';

type Props = {
  icon: ReactNode;
  ariaLabel: string;
  onClick(e: MouseEvent<HTMLButtonElement>): void;
  danger?: boolean;
  className?: string;
};

export function IconButton({ icon, ariaLabel, onClick, danger, className }: Props) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      className={cn(
        'inline-flex h-[26px] w-[26px] items-center justify-center rounded-[5px] text-text-tertiary transition-colors',
        danger
          ? 'hover:bg-danger-soft hover:text-danger'
          : 'hover:bg-accent-soft hover:text-accent',
        className,
      )}
    >
      {icon}
    </button>
  );
}
