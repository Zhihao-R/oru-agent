/**
 * 筛选浮层（A5）——类型 / 标签两组纯文字，当前项下划线；清空 / 应用。
 * 草稿态：改动落本地 draft，「应用」才提交给主页 filter（承接现状摘要行语义，D6）。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { EpisodeType } from '@shared/types';
import { useMemoryStore } from '@/stores/memoryStore';
import { ALL_TYPES, typeLabel } from '@/components/memory/shared/typeLabels';
import { EMPTY_FILTER, type NoteFilter } from '../homeTypes';
import { Overlay } from './Overlay';
import { cn } from '@/lib/cn';

type Props = {
  filter: NoteFilter;
  onApply: (filter: NoteFilter) => void;
  onClose: () => void;
};

export function FilterOverlay({ filter, onApply, onClose }: Props) {
  const { t } = useTranslation('home');
  const { t: tm } = useTranslation('memory');
  const episodes = useMemoryStore((s) => s.episodes);
  const allTags = useMemo(() => {
    const s = new Set<string>();
    episodes.forEach((e) => e.tags.forEach((tag) => s.add(tag)));
    return [...s].sort();
  }, [episodes]);

  const [type, setType] = useState<EpisodeType | null>(filter.type);
  const [tags, setTags] = useState<Set<string>>(new Set(filter.tags));

  const toggleTag = (tag: string) =>
    setTags((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });

  return (
    <Overlay width={360} maxHeight={560} onClose={onClose}>
      <div className="px-[34px] pb-6 pt-[30px]">
        <div className="font-serif text-[18px] font-semibold tracking-[-0.01em] text-text-primary">{t('filter.title')}</div>

        <div className="mb-2.5 mt-[22px] font-mono text-[10px] tracking-[0.14em] text-text-quaternary">
          {t('filter.typeLabel')}
        </div>
        <div className="flex flex-wrap items-baseline gap-[18px]">
          <FilterChip active={type === null} onClick={() => setType(null)}>
            {t('filter.all')}
          </FilterChip>
          {ALL_TYPES.map((tp) => (
            <FilterChip key={tp} active={type === tp} onClick={() => setType(type === tp ? null : tp)}>
              {typeLabel(tp, tm)}
            </FilterChip>
          ))}
        </div>

        {allTags.length > 0 && (
          <>
            <div className="mb-2.5 mt-5 font-mono text-[10px] tracking-[0.14em] text-text-quaternary">
              {t('filter.tagLabel')}
            </div>
            <div className="flex flex-wrap items-baseline gap-[18px]">
              {allTags.map((tag) => (
                <FilterChip key={tag} active={tags.has(tag)} onClick={() => toggleTag(tag)}>
                  # {tag}
                </FilterChip>
              ))}
            </div>
          </>
        )}

        <div className="mt-[26px] flex items-baseline justify-end gap-6 border-t border-border pt-3.5">
          <button
            type="button"
            onClick={() => {
              setType(null);
              setTags(new Set());
            }}
            className="text-[13px] text-text-tertiary hover:text-text-primary"
          >
            {t('filter.clear')}
          </button>
          <button
            type="button"
            onClick={() => onApply(type === null && tags.size === 0 ? EMPTY_FILTER : { type, tags })}
            className="border-b border-accent pb-px text-[13px] font-semibold text-accent-deep"
          >
            {t('filter.apply')}
          </button>
        </div>
      </div>
    </Overlay>
  );
}

function FilterChip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'border-b pb-0.5 text-[13px] transition-colors',
        active ? 'border-accent font-semibold text-accent-deep' : 'border-transparent text-text-tertiary hover:text-text-primary',
      )}
    >
      {children}
    </button>
  );
}
