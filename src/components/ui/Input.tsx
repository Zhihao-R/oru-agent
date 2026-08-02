import { forwardRef, type InputHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(
        'h-8 w-full rounded-md border bg-elevated px-2.5 text-sm text-text-primary placeholder:text-text-tertiary',
        'transition-colors duration-150 focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring',
        invalid ? 'border-danger' : 'border-border hover:border-border-strong',
        className,
      )}
      {...rest}
    />
  );
});
