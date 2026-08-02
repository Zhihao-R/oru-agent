import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

// primary=主题色实心批准 / ghost=素操作 / danger=素危险文字 /
// dangerSolid=破坏性确认实心红（不变量：破坏性操作确认按钮必须红）/ outline=描边（如「始终允许」）
type Variant = 'primary' | 'ghost' | 'danger' | 'dangerSolid' | 'outline';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

const base =
  'inline-flex items-center justify-center gap-1.5 font-medium tracking-tight transition-[background-color,color,border-color,opacity] duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50 disabled:cursor-not-allowed select-none';

const variantCls: Record<Variant, string> = {
  primary:
    'bg-accent text-accent-fg hover:opacity-90 active:opacity-95 border border-transparent',
  ghost:
    'bg-transparent text-text-primary hover:bg-hover border border-transparent',
  danger:
    'bg-transparent text-danger hover:bg-danger-soft border border-transparent',
  dangerSolid:
    'bg-danger text-danger-fg hover:opacity-90 active:opacity-95 border border-transparent',
  outline:
    'bg-transparent text-accent hover:bg-accent-soft border border-accent',
};

const sizeCls: Record<Size, string> = {
  sm: 'h-7 px-2.5 text-xs rounded-md',
  md: 'h-8 px-3 text-sm rounded-md',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'ghost', size = 'md', className, leftIcon, rightIcon, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(base, variantCls[variant], sizeCls[size], className)}
      {...rest}
    >
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});
