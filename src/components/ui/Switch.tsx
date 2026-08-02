/**
 * 通用开关 —— 设置页所有 boolean 状态都走这个。
 *
 * 比例 ≈ iOS（容器/滑块 ≈ 1.75），收紧自之前 30×18 的"滑块小、留白多"的版本。
 * 滑块用 `left-[2px]` 显式锚定 + transform 平移：absolute 不能依赖 static
 * position（父 button 的 line-height/text-align 会把它推飞，曾经出现整个滑块跑到容器外）。
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  ariaLabel: string;
}

export function Switch({ checked, onChange, disabled, ariaLabel }: SwitchProps): ReactNode {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        e.preventDefault();
        if (!disabled) onChange(!checked);
      }}
      className={cn(
        'relative inline-block h-4 w-7 flex-shrink-0 rounded-full transition-colors',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring',
        checked ? 'bg-accent' : 'bg-border-strong',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <span
        className={cn(
          'absolute left-[2px] top-[2px] inline-block h-3 w-3 rounded-full bg-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition-transform',
          checked ? 'translate-x-[12px]' : 'translate-x-0',
        )}
      />
    </button>
  );
}
