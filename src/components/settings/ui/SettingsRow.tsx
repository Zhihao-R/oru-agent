/**
 * 设置页统一的「label + 描述 + 右侧控件」行。
 *
 * 行之间靠极淡 hairline 分隔（last:border-b-0）。
 * description 强约束单行（克制原则）——超过一行说明文案没写到位。
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function SettingsRow({
  label,
  description,
  control,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-4 border-b border-border py-3 last:border-b-0',
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-sm text-text-primary">{label}</div>
        {description ? (
          <div className="mt-0.5 truncate text-xs text-text-tertiary">{description}</div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">{control}</div>
    </div>
  );
}
