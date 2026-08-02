/**
 * 笔记（P5）——最近 7 条，行 = 日期 mono / 类型徽 / 标题 / dream 徽 / hover × 删；
 * 节头「最近 7 / 共 N」+「全部类型 ▾」单一过滤器（开筛选浮层，摘要回显当前筛选）；
 * 尾部「翻旧账 · 收起了 N 条」（分段加载）与「已整理掉 N 条」（仅收 dream 整理产物，灰列表，已拍板 E5）。
 *
 * 用户备忘徽（source=user-direct）按已拍板 D3 行内退役，移进详情浮层眉标。
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { EpisodeType } from '@shared/types';
import { useMemoryStore } from '@/stores/memoryStore';
import { ALL_TYPES, TYPE_CHIP_STYLE, typeLabel } from '@/components/memory/shared/typeLabels';
import type { NoteFilter } from '../homeTypes';

type EpisodeEntry = ReturnType<typeof useMemoryStore.getState>['episodes'][number];

const INITIAL = 7;
const STEP = 20;

function displayTitleOf(ep: EpisodeEntry, noTitle: string): string {
  const ellipsized = /(?:…|\.{3})\s*$/.test(ep.title || '');
  return (ellipsized && ep.description ? ep.description : ep.title) || noTitle;
}

function typeKeyOf(ep: EpisodeEntry): EpisodeType {
  return ALL_TYPES.includes(ep.type as EpisodeType) ? (ep.type as EpisodeType) : 'agent';
}

type Props = {
  filter: NoteFilter;
  onOpenFilter: () => void;
  onOpenNote: (relPath: string) => void;
};

export function NotesSection({ filter, onOpenFilter, onOpenNote }: Props) {
  const { t } = useTranslation('home');
  const { t: tm } = useTranslation('memory');
  const episodes = useMemoryStore((s) => s.episodes);
  const retiredEpisodes = useMemoryStore((s) => s.retiredEpisodes);
  const deleteEpisode = useMemoryStore((s) => s.deleteEpisode);

  const [shown, setShown] = useState(INITIAL);
  const [retiredOpen, setRetiredOpen] = useState(false);

  const filtered = useMemo(
    () =>
      episodes.filter((e) => {
        if (filter.type && typeKeyOf(e) !== filter.type) return false;
        for (const tag of filter.tags) if (!e.tags.includes(tag)) return false;
        return true;
      }),
    [episodes, filter],
  );

  const visible = filtered.slice(0, shown);
  const collapsed = filtered.length - visible.length;

  const filterSummary =
    filter.type === null && filter.tags.size === 0
      ? t('notes.filterAll')
      : [filter.type ? typeLabel(filter.type, tm) : null, ...[...filter.tags].map((x) => `#${x}`)]
          .filter(Boolean)
          .join(' · ');

  return (
    <section>
      <div className="flex items-center gap-2.5">
        <h2 className="m-0 font-serif text-[21px] font-semibold text-text-primary">{t('notes.heading')}</h2>
        <span className="text-[12px] text-text-quaternary">
          {t('notes.countSummary', { shown: visible.length, total: filtered.length })}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onOpenFilter}
          className="inline-flex h-[26px] items-center gap-1.5 rounded-full border border-border-strong bg-elevated px-[11px] text-[12px] text-text-secondary hover:border-border-heavy"
        >
          {filterSummary} <span className="text-text-quaternary">▾</span>
        </button>
      </div>

      <div className="mt-2 flex flex-col">
        {visible.map((ep) => (
          <NoteRow
            key={ep.relPath}
            ep={ep}
            noTitle={tm('events.noTitle')}
            onOpen={() => onOpenNote(ep.relPath)}
            onDelete={() => void deleteEpisode(ep.relPath)}
            deleteTitle={t('notes.deleteTitle')}
          />
        ))}
        {visible.length === 0 && (
          <div className="py-6 text-center text-[13px] text-text-tertiary">{tm('events.noMatch')}</div>
        )}
      </div>

      <div className="mt-2.5 flex items-center gap-4 text-[12px]">
        {collapsed > 0 && (
          <button type="button" onClick={() => setShown((n) => n + STEP)} className="text-accent-deep">
            {t('notes.moreNotes', { count: collapsed })}
          </button>
        )}
        {retiredEpisodes && retiredEpisodes.length > 0 && (
          <button
            type="button"
            onClick={() => setRetiredOpen((v) => !v)}
            className="text-text-quaternary hover:text-text-secondary"
          >
            {t('notes.retired', { count: retiredEpisodes.length })}
          </button>
        )}
      </div>

      {retiredOpen && retiredEpisodes && (
        <div className="mt-2 flex flex-col">
          {retiredEpisodes.map((ep) => (
            <RetiredRow key={ep.relPath} ep={ep} noTitle={tm('events.noTitle')} tm={tm} />
          ))}
        </div>
      )}
    </section>
  );
}

function NoteRow({
  ep,
  noTitle,
  onOpen,
  onDelete,
  deleteTitle,
}: {
  ep: EpisodeEntry;
  noTitle: string;
  onOpen: () => void;
  onDelete: () => void;
  deleteTitle: string;
}) {
  const chip = TYPE_CHIP_STYLE[typeKeyOf(ep)];
  const { t: tm } = useTranslation('memory');
  return (
    <div
      onClick={onOpen}
      className="group -mx-2.5 flex h-9 cursor-pointer items-center gap-2.5 rounded px-2.5 transition-colors hover:bg-sunken-2"
    >
      <span className="w-[46px] shrink-0 font-mono text-[11px] tabular-nums text-text-quaternary">
        {(ep.date || '').slice(5)}
      </span>
      <span
        className="shrink-0 rounded-xs px-[7px] py-px text-[10.5px]"
        style={{ color: chip.color, background: chip.background }}
      >
        {typeLabel(typeKeyOf(ep), tm)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-text-primary">{displayTitleOf(ep, noTitle)}</span>
      {ep.correctedAt && (
        <span className="shrink-0 rounded-xs border border-border-strong px-[5px] font-mono text-[10px] tracking-[0.06em] text-text-quaternary">
          dream
        </span>
      )}
      <button
        type="button"
        title={deleteTitle}
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-quaternary opacity-0 transition-opacity hover:bg-border hover:text-text-secondary group-hover:opacity-100"
      >
        <X size={9} strokeWidth={1.8} />
      </button>
    </div>
  );
}

function RetiredRow({
  ep,
  noTitle,
  tm,
}: {
  ep: EpisodeEntry;
  noTitle: string;
  tm: ReturnType<typeof useTranslation>['t'];
}) {
  const chip = TYPE_CHIP_STYLE[typeKeyOf(ep)];
  return (
    <div className="flex h-9 items-center gap-2.5 px-2.5 opacity-60">
      <span className="w-[46px] shrink-0 font-mono text-[11px] tabular-nums text-text-quaternary">
        {(ep.date || '').slice(5)}
      </span>
      <span
        className="shrink-0 rounded-xs px-[7px] py-px text-[10.5px] opacity-70"
        style={{ color: chip.color, background: chip.background }}
      >
        {typeLabel(typeKeyOf(ep), tm)}
      </span>
      <span className="min-w-0 flex-1 truncate text-[13px] text-text-quaternary">
        {ep.title || ep.description || noTitle}
      </span>
      {ep.retiredReason && (
        <span className="shrink-0 text-[11px] text-text-quaternary">{ep.retiredReason}</span>
      )}
    </div>
  );
}
