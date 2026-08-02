/**
 * Settings ▸ 用量（理想架构 S13 · G110）
 *
 * 按用途归账的用量账本：主对话 / 记忆召回 / 夜间整理 / subagent / Loop 各花了多少 token，用户随时
 * 能看见。用途名复用模型分配区同一套（backend.usage.*）——看到某用途花得多，去「模型」区给它换个
 * 便宜模型，正是分配表现成的把手。只计 token（既成事实、不过期）；金额不做（2026-07-10 PM 拍板：
 * 金额需一份会过期的价目表、易被当真实账单，token 就够）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { BudgetSettings, LlmUsage } from '@shared/types';
import type { UsageLedgerFile, UsageSummary } from '@shared/usage/types';
import type { UsageStateEvent } from '@shared/protocol';
import { summarizeUsage } from '@shared/usage/summarize';
import { evaluateBudget } from '@shared/budget/evaluate';
import { DEFAULT_BUDGET } from '@shared/budget/types';
import { wsClient } from '@/lib/ws';
import { useOruName } from '@/lib/oruName';
import { useSettingsStore } from '@/stores/settingsStore';
import { SettingsSection } from '@/components/settings/ui/SettingsSection';
import { SettingsRow } from '@/components/settings/ui/SettingsRow';
import { Switch } from '@/components/ui/Switch';
import { cn } from '@/lib/cn';

/** 滚动窗口：近 30 天（与主进程预算窗口口径一致）。 */
const BUDGET_WINDOW_MS = 30 * 24 * 3600_000;

type RangeId = 'today' | 'week' | 'month' | 'all';
const RANGE_IDS: RangeId[] = ['today', 'week', 'month', 'all'];

/** 各范围的起始时刻（本地）；null = 不限。 */
function rangeStart(id: RangeId): number | null {
  if (id === 'all') return null;
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  if (id === 'today') return d.getTime();
  if (id === 'week') {
    // 从本周一 0 点起（周日=0 折到上周一）
    const dow = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - dow);
    return d.getTime();
  }
  d.setDate(1); // 本月 1 号
  return d.getTime();
}

/** token 数缩写：≥1M → 1.2M，≥1k → 820k，否则原值。 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

/** 用途展示名——复用模型分配区的 backend.usage.*，把手才对得上。 */
function usageLabel(usage: LlmUsage, name: string, t: TFunction): string {
  return t(`backend.usage.${usage}`, { name });
}

export function UsageSection() {
  const { t } = useTranslation('settings');
  const oruName = useOruName();
  const [days, setDays] = useState<UsageLedgerFile['days'] | null>(null);
  const [range, setRange] = useState<RangeId>('month');

  useEffect(() => {
    void (async () => {
      try {
        const res = await wsClient.request<UsageStateEvent>({ type: 'usage.get' });
        setDays(res.days);
      } catch {
        setDays({});
      }
    })();
  }, []);

  const summary: UsageSummary | null = useMemo(
    () => (days ? summarizeUsage(days, { from: rangeStart(range) }) : null),
    [days, range],
  );

  return (
    <div className="mx-auto max-w-[640px] px-12 py-12">
      <h1 className="mb-2 font-serif text-[30px] font-semibold leading-[1.15] tracking-tight">
        {t('usage.heading')}
      </h1>
      <p className="mb-8 text-sm text-text-secondary">{t('usage.subtitle')}</p>

      {/* 范围切换 */}
      <div className="mb-6 flex gap-1">
        {RANGE_IDS.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setRange(id)}
            className={cn(
              'rounded-md px-3 py-1 text-sm transition-colors',
              range === id
                ? 'bg-accent-soft font-medium text-accent'
                : 'text-text-secondary hover:bg-hover hover:text-text-primary',
            )}
          >
            {t(`usage.range.${id}`)}
          </button>
        ))}
      </div>

      {summary === null ? (
        <p className="text-sm text-text-tertiary">{t('usage.loading')}</p>
      ) : summary.byPurpose.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t('usage.empty')}</p>
      ) : (
        <SettingsSection title={t('usage.byPurposeTitle')}>
          {/* 总计 */}
          <div className="mb-4 flex items-baseline justify-between border-b border-border pb-3">
            <span className="text-sm font-medium text-text-primary">{t('usage.total')}</span>
            <span className="font-mono text-sm text-text-primary">
              {fmtTokens(summary.total.inputTokens + summary.total.outputTokens)} tokens
            </span>
          </div>
          {/* 按用途条形图：label + 轨道 + mono 数值；条宽以最大项为 100% 基准，大头一眼可见 */}
          <PurposeBars rows={summary.byPurpose} oruName={oruName} t={t} />
          <p className="mt-6 text-xs text-text-tertiary">{t('usage.tokenOnlyNote')}</p>
        </SettingsSection>
      )}

      <BudgetControls days={days} t={t} />
    </div>
  );
}

/** 按用途条形图：label(108px) + 轨道 + mono 数值，单色 accent，轨道 bg-sunken。条宽 = 本行 / 最大行。 */
function PurposeBars({
  rows,
  oruName,
  t,
}: {
  rows: UsageSummary['byPurpose'];
  oruName: string;
  t: TFunction;
}) {
  const max = Math.max(1, ...rows.map((r) => r.inputTokens + r.outputTokens));
  return (
    <div className="space-y-0.5">
      {rows.map((row) => {
        const rowTotal = row.inputTokens + row.outputTokens;
        const pct = Math.max(2, Math.round((rowTotal / max) * 100)); // 下限 2%，极小项也留一丝可见
        return (
          <div
            key={row.purpose}
            className="grid items-center gap-3 py-[9px]"
            style={{ gridTemplateColumns: '108px 1fr 56px' }}
          >
            <span className="truncate text-[13px] text-text-secondary" title={usageLabel(row.purpose, oruName, t)}>
              {usageLabel(row.purpose, oruName, t)}
            </span>
            <span className="block h-1.5 overflow-hidden rounded-full bg-sunken">
              <span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
            </span>
            <span className="text-right font-mono text-xs text-text-tertiary">{fmtTokens(rowTotal)}</span>
          </div>
        );
      })}
    </div>
  );
}

/** token 输入以「百万 token（M）」为单位，人更好填；存回 settings 仍是原始 token 数。 */
const TOKENS_PER_M = 1_000_000;

/**
 * 用量预算两级线（S15）。默认关——预算是用户对自己钱包的决定权。开启后填月度…（滚动 30 天）硬上限，
 * 到软警戒线发通知（事前警戒），到硬上限无人值守任务暂停进通知中心、前台对话仅告知不阻断。
 */
function BudgetControls({ days, t }: { days: UsageLedgerFile['days'] | null; t: TFunction }) {
  const budget = useSettingsStore((s) => s.settings.budget) ?? DEFAULT_BUDGET;
  const update = useSettingsStore((s) => s.update);
  const patch = (over: Partial<BudgetSettings>) => void update({ budget: { ...budget, ...over } });

  // 近 30 天已用（口径同主进程），配合配置算当前处于哪一级线，给用户一条实时状态。
  const spent = useMemo(() => {
    if (!days) return 0;
    const s = summarizeUsage(days, { from: Date.now() - BUDGET_WINDOW_MS });
    return s.total.inputTokens + s.total.outputTokens;
  }, [days]);
  const status = evaluateBudget(spent, budget);
  const pct = status.hardLimitTokens > 0 ? Math.round((spent / status.hardLimitTokens) * 100) : 0;

  return (
    <SettingsSection title={t('budget.title')}>
      <SettingsRow
        label={t('budget.enable')}
        description={t('budget.enableDesc')}
        control={<Switch checked={budget.enabled} onChange={(next) => patch({ enabled: next })} ariaLabel={t('budget.enable')} />}
      />
      {budget.enabled ? (
        <>
          {/* 现状先行：近 30 天已用对硬上限的占比进度条（放设置项之前） */}
          <div className="border-b border-border py-4">
            <span className="block h-1.5 overflow-hidden rounded-full bg-sunken">
              <span
                className={cn(
                  'block h-full rounded-full',
                  status.level === 'hard' ? 'bg-danger' : status.level === 'soft' ? 'bg-warn' : 'bg-accent',
                )}
                style={{ width: `${Math.min(100, pct)}%` }}
              />
            </span>
            <div className="mt-1.5 flex justify-between text-xs text-text-tertiary">
              <span>{t('budget.spentCaption')}</span>
              <span className="font-mono">
                {fmtTokens(spent)} / {fmtTokens(status.hardLimitTokens)}
              </span>
            </div>
          </div>
          <SettingsRow
            label={t('budget.hardLimit')}
            description={t('budget.hardLimitDesc')}
            control={
              <NumberField
                value={budget.hardLimitTokens / TOKENS_PER_M}
                suffix="M"
                min={1}
                onCommit={(n) => patch({ hardLimitTokens: Math.max(1, Math.round(n)) * TOKENS_PER_M })}
              />
            }
          />
          <SettingsRow
            label={t('budget.softRatio')}
            description={t('budget.softRatioDesc')}
            control={
              <NumberField
                value={Math.round(budget.softRatio * 100)}
                suffix="%"
                min={1}
                max={100}
                onCommit={(n) => patch({ softRatio: Math.min(100, Math.max(1, Math.round(n))) / 100 })}
              />
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}

/** 失焦提交的数字输入——避免每敲一位就 update 一次；空/非法回落不提交。 */
function NumberField({
  value,
  suffix,
  min,
  max,
  onCommit,
}: {
  value: number;
  suffix: string;
  min?: number;
  max?: number;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (Number.isFinite(n) && n > 0) onCommit(n);
    else setDraft(String(value));
  };
  return (
    <span className="flex items-baseline gap-1.5">
      <input
        type="number"
        value={draft}
        min={min}
        max={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        className="w-20 rounded-md border border-border bg-elevated px-2 py-1 text-right font-mono text-sm text-text-primary focus:border-accent focus:outline-none"
      />
      <span className="text-xs text-text-tertiary">{suffix}</span>
    </span>
  );
}
