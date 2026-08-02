/**
 * 往期夜记浮层（A5）——本周列表（日期 / 首句 / N 笔）+「更早按月归档，滚动加载」；
 * 行点开直接展开该晚全文 + 明细（已拍板 E6b）。数据沿用 parseChangelog（去掉最新一篇=昨夜已展）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseChangelog, type Night } from '@/components/memory/changelogParse';
import { useMemoryStore } from '@/stores/memoryStore';
import { Overlay } from './Overlay';

function firstSentence(note: string): string {
  const s = note.trim();
  const cut = s.search(/[。.!?！？]/);
  return cut > 0 ? s.slice(0, cut + 1) : s;
}

export function PastNightsOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('home');
  const changelog = useMemoryStore((s) => s.changelog);
  const nights = parseChangelog(changelog ?? '').slice(1); // 去掉最新一篇（昨夜节已展）

  return (
    <Overlay width={460} maxHeight={620} onClose={onClose}>
      <div className="px-9 pb-6 pt-8">
        <div className="mb-3.5 flex items-baseline gap-3">
          <span className="font-serif text-[19px] font-semibold tracking-[-0.01em] text-text-primary">
            {t('nights.title')}
          </span>
          <span className="font-mono text-[10.5px] tracking-[0.1em] text-text-quaternary">
            {t('nights.weekCount', { count: nights.length })}
          </span>
        </div>
        <div className="flex flex-col">
          {nights.map((n) => (
            <NightItem key={n.date} night={n} />
          ))}
        </div>
        <div className="mt-3 text-[12px] text-text-quaternary">{t('nights.archiveNote')}</div>
      </div>
    </Overlay>
  );
}

function NightItem({ night }: { night: Night }) {
  const { t } = useTranslation('home');
  const [open, setOpen] = useState(false);
  const [, m, d] = night.date.split('-');
  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="-mx-2.5 flex h-[38px] w-[calc(100%+20px)] items-center gap-2.5 rounded px-2.5 text-left transition-colors hover:bg-sunken-2"
      >
        <span className="w-[46px] shrink-0 font-mono text-[11px] text-text-quaternary">
          {t('memory:colophonDate', { month: Number(m), day: Number(d) })}
        </span>
        <span className="min-w-0 flex-1 truncate text-[13px] text-text-secondary">
          {firstSentence(night.note) || (night.details[0] ?? '')}
        </span>
        <span className="shrink-0 text-[11px] text-text-quaternary">
          {t('nights.perNight', { count: night.details.length })}
        </span>
      </button>
      {open && (
        <div className="pb-3">
          {night.note && (
            <p className="mt-1 text-[13.5px] leading-[1.9] text-text-primary">{night.note}</p>
          )}
          {night.details.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5 border-l-2 border-border-strong py-0.5 pl-3.5">
              {night.details.map((line, i) => (
                <div key={`${i}-${line.slice(0, 20)}`} className="text-[12px] text-text-secondary">
                  {line}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
