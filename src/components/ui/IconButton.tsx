import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: 'sm' | 'md';
  label: string;
  children: ReactNode;
}

const sizes: Record<'sm' | 'md', string> = {
  sm: 'h-7 w-7',
  md: 'h-8 w-8',
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { size = 'md', label, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center rounded-md text-text-secondary transition-colors duration-150 hover:bg-hover hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-ring disabled:opacity-50',
        sizes[size],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});
