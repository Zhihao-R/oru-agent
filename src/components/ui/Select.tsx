import { forwardRef, type SelectHTMLAttributes } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  options: SelectOption[];
  size?: 'sm' | 'md';
}

const sizeCls: Record<'sm' | 'md', string> = {
  sm: 'h-7 pl-2 pr-7 text-xs',
  md: 'h-8 pl-2.5 pr-8 text-sm',
};

export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { options, className, size = 'md', ...rest },
  ref,
) {
  return (
    <div className="relative inline-flex items-center">
      <select
        ref={ref}
        className={cn(
          'appearance-none rounded-md border border-border bg-elevated text-text-primary',
          'transition-colors duration-150 hover:border-border-strong focus:outline-none focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-ring',
          sizeCls[size],
          className,
        )}
        {...rest}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2 text-text-tertiary"
        size={14}
        strokeWidth={1.5}
      />
    </div>
  );
});
