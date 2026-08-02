/**
 * 设置页统一的 section 容器。
 *
 * 一个小标题（H3）+ 右侧可选 trailing slot（章节级动作，如「+ 添加」）。
 * Section 之间靠外部 mt-* 间距区分，不画框、不画分隔线。
 *
 * H3 字号 15px / sans / semibold / text-primary —— 介于 14px 设置项和 30px serif 主标题之间，
 * 有「小章节」的份量但不抢主标题；颜色用 primary（不再灰），让它成为视觉锚点。
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function SettingsSection({
  title,
  trailing,
  className,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cn('mt-10 first:mt-0', className)}>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-[15px] font-semibold tracking-tight text-text-primary">
          {title}
        </h3>
        {trailing ? <div className="flex items-center gap-1">{trailing}</div> : null}
      </div>
      <div>{children}</div>
    </section>
  );
}
