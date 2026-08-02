/**
 * Settings 左导航 —— 七项一级 tab，无子目录展开。
 * 每项一枚极简线形 icon（1.5 描边），激活随 accent。
 */
import { useTranslation } from 'react-i18next';
import {
  SlidersHorizontal,
  ShieldCheck,
  Cpu,
  BarChart3,
  Blocks,
  Cable,
  Database,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/cn';
import type { SettingsTab } from '@/pages/SettingsPage';

const TABS: { id: SettingsTab; icon: LucideIcon }[] = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'permissions', icon: ShieldCheck },
  { id: 'models', icon: Cpu },
  { id: 'usage', icon: BarChart3 },
  { id: 'capabilities', icon: Blocks },
  { id: 'platforms', icon: Cable },
  { id: 'data', icon: Database },
];

export function SettingsNav({
  current,
  onChange,
}: {
  current: SettingsTab;
  onChange: (next: SettingsTab) => void;
}) {
  const { t } = useTranslation('settings');
  return (
    <nav className="border-r border-border bg-sunken px-3 py-7">
      <div className="mb-4 px-2 font-serif text-[22px] font-semibold tracking-tight text-text-primary">
        {t('nav.title')}
      </div>
      <ul className="space-y-0.5">
        {TABS.map(({ id, icon: Icon }) => (
          <li key={id}>
            <button
              type="button"
              onClick={() => onChange(id)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
                current === id
                  ? 'bg-accent-soft font-medium text-accent'
                  : 'text-text-secondary hover:bg-hover hover:text-text-primary',
              )}
            >
              <Icon
                size={15}
                strokeWidth={1.5}
                className={cn('shrink-0', current === id ? 'text-accent' : 'text-text-tertiary')}
              />
              {t(`nav.${id}`)}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
