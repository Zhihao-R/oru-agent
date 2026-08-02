/**
 * 昨夜（P1）——最新一篇夜记全文 + 明细内联展开 + 往期浮层入口。
 * 夜记解析沿用 changelogParse 的 parseChangelog（changelog.md 分夜）。
 *
 * 三态：
 * - 有夜记：标题行（dream 徽 + 完成时间）+ 全文 + 「明细(N 笔)」+「往期 N 篇 ›」；
 * - 有笔记但 dream 未跑（E8 中间态）：小知口吻预告 +「现在就整理一次 ›」触发一次 dream；
 * - 完全零数据：虚线引导框（A7）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Night } from '@/components/memory/changelogParse';

// changelog 明细行的动作前缀由 dream 按 owner 语言写入，owner 为英文时不命中、退化为纯文本行。
// i18n-exempt：按中文数据格式匹配并原样回显，非 UI 文案（数据哨兵，CLAUDE.md 四类边界）
const ACTION_TAGS = ['升级', '合并', '新写', '归档', '校对', '降级', '新增', '删除', '保留'];

/** 把明细行拆成「前导动作 mono 标签 + 其余文本」——动作词取真实 changelog 行的首词。 */
function splitAction(line: string): { tag: string | null; rest: string } {
  for (const tag of ACTION_TAGS) {
    if (line.startsWith(tag)) return { tag, rest: line.slice(tag.length).replace(/^[:：\s]+/, '') };
  }
  return { tag: null, rest: line };
}

type Props = {
  nights: Night[];
  hasEpisodes: boolean;
  onOpenNights: () => void;
  onRunDream: () => Promise<boolean>;
};

export function NightSection({ nights, hasEpisodes, onOpenNights, onRunDream }: Props) {
  const { t } = useTranslation('home');

  if (nights.length === 0) {
    if (hasEpisodes) return <NightForecast onRunDream={onRunDream} />;
    // 完全零数据：虚线引导框
    return (
      <section>
        <h2 className="m-0 font-serif text-[21px] font-semibold text-text-primary">{t('night.heading')}</h2>
        <div className="mt-3 rounded-sm border border-dashed border-border-strong px-4 py-5 text-[14px] leading-[1.9] text-text-quaternary">
          {t('night.zeroData')}
        </div>
      </section>
    );
  }

  return <NightBody latest={nights[0]} olderCount={nights.length - 1} onOpenNights={onOpenNights} />;
}

function NightBody({
  latest,
  olderCount,
  onOpenNights,
}: {
  latest: Night;
  olderCount: number;
  onOpenNights: () => void;
}) {
  const { t } = useTranslation('home');
  const [detailOpen, setDetailOpen] = useState(false);
  const [, m, d] = latest.date.split('-');
  return (
    <section>
      <div className="flex items-baseline gap-2.5">
        <h2 className="m-0 font-serif text-[21px] font-semibold text-text-primary">{t('night.heading')}</h2>
        <span className="font-mono text-[11px] text-text-quaternary">
          {t('memory:colophonDate', { month: Number(m), day: Number(d) })}
        </span>
        <span className="flex-1" />
        {/* dream 徽：夜间整理产物（产品术语，保留原文不译） */}
        <span
          title={t('night.heading')}
          className="rounded-xs border border-border-strong px-1.5 py-px font-mono text-[10px] tracking-[0.06em] text-text-quaternary"
        >
          dream
        </span>
      </div>
      {latest.note && (
        <p className="mt-3 text-[14.5px] leading-[1.9] text-text-primary">{latest.note}</p>
      )}
      <div className="mt-3 flex items-center gap-3.5">
        {latest.details.length > 0 && (
          <button
            type="button"
            onClick={() => setDetailOpen((v) => !v)}
            className="text-[12px] text-accent-deep"
          >
            {detailOpen ? t('night.detailsCollapse') : t('night.detailsLabel', { count: latest.details.length })}
          </button>
        )}
        {olderCount > 0 && (
          <button type="button" onClick={onOpenNights} className="text-[12px] text-text-quaternary hover:text-text-secondary">
            {t('night.olderNights', { count: olderCount })}
          </button>
        )}
      </div>
      {detailOpen && latest.details.length > 0 && (
        <div className="mt-2.5 flex flex-col gap-[7px] border-l-2 border-border-strong py-0.5 pl-3.5">
          {latest.details.map((line, i) => {
            const { tag, rest } = splitAction(line);
            return (
              <div key={`${i}-${line.slice(0, 20)}`} className="text-[12.5px] text-text-secondary">
                {tag && <span className="mr-2 font-mono text-[10.5px] text-text-quaternary">{tag}</span>}
                {rest}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function NightForecast({ onRunDream }: { onRunDream: () => Promise<boolean> }) {
  const { t } = useTranslation('home');
  const [state, setState] = useState<'idle' | 'running' | 'failed'>('idle');

  const run = async () => {
    if (state === 'running') return;
    setState('running');
    const ok = await onRunDream();
    setState(ok ? 'idle' : 'failed'); // 成功后 changelog 刷新 → 本节由父级切到 NightBody
  };

  return (
    <section>
      <h2 className="m-0 font-serif text-[21px] font-semibold text-text-primary">{t('night.heading')}</h2>
      <p className="mt-3 text-[14.5px] leading-[1.9] text-text-secondary">{t('night.forecast')}</p>
      <button
        type="button"
        onClick={() => void run()}
        disabled={state === 'running'}
        className="mt-2 text-[12px] text-accent-deep disabled:text-text-quaternary"
      >
        {state === 'running' ? t('night.running') : state === 'failed' ? t('night.runFailed') : t('night.runNow')}
      </button>
    </section>
  );
}
