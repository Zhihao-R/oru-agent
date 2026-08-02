/**
 * 左栏：调试日志 round 列表 —— 紧凑双行布局
 *
 * 一行 = 一次"行为"（一次问答 / 一条评论 / 一次任务执行 / 一次后台触发）。
 * 同一 conversation 的多轮以多条独立行展示，按 startTs 倒序铺平。
 *
 * 视觉详 docs/prd/2026-05-10-debug-redesign-prd.md §2.1 / §2.4 / §2.5。
 */
import { useTranslation } from 'react-i18next';
import type { RoundSource, RoundSummary } from '@shared/debug/types';
import { fmtDuration } from '@/lib/fmtDuration';

export interface RoundListSelectedKey {
  dateKey: string;
  conversationId: string;
  roundId: string;
}

export function RoundList({
  rounds,
  loading,
  selectedKey,
  onSelect,
}: {
  rounds: RoundSummary[];
  loading: boolean;
  selectedKey: RoundListSelectedKey | null;
  onSelect: (key: RoundListSelectedKey) => void;
}) {
  const { t } = useTranslation('debug');
  if (loading && rounds.length === 0) {
    return <div className="p-4 text-sm text-text-tertiary">{t('common:loading')}</div>;
  }
  if (rounds.length === 0) {
    return <div className="p-4 text-sm text-text-tertiary">{t('roundList.empty')}</div>;
  }
  return (
    <ul className="divide-y divide-border">
      {rounds.map((r) => {
        const selected =
          selectedKey?.dateKey === r.dateKey &&
          selectedKey?.conversationId === r.conversationId &&
          selectedKey?.roundId === r.roundId;
        return (
          <li key={`${r.dateKey}-${r.conversationId}-${r.roundId}`}>
            <button
              type="button"
              onClick={() =>
                onSelect({
                  dateKey: r.dateKey,
                  conversationId: r.conversationId,
                  roundId: r.roundId,
                })
              }
              className={`relative grid w-full grid-cols-[auto_1fr_auto] items-start gap-3 px-3 py-2 text-left transition-colors ${
                selected ? 'bg-accent-soft' : 'hover:bg-hover'
              }`}
            >
              {selected ? (
                <span
                  aria-hidden="true"
                  className="absolute left-0 top-0 h-full w-[3px] bg-accent"
                />
              ) : null}

              {/* 第一列：类型 chip */}
              <SourceChip source={r.source} />

              {/* 第二列：双行主体 */}
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-text-primary">
                  {r.userText || <span className="text-text-tertiary">{t('roundList.noUserText')}</span>}
                </div>
                <MetaLine round={r} />
              </div>

              {/* 第三列：耗时 */}
              <DurationCell round={r} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** 类型徽章——圆点 + 中文短词。仅 main_chat 用 accent 强化（"对话是主线索"），
 *  其它 source 一律灰色——靠中文短词区分类别，不靠色相。详 PRD §2.4。 */
function SourceChip({ source }: { source: RoundSource }) {
  const { t } = useTranslation('debug');
  // source 是稳定枚举 key，按 key 取词；未知 source 回落 unknown（与原 SOURCE_LABEL.unknown 兜底同义）
  const label = t([`source.${source}`, 'source.unknown']);
  const isMain = source === 'main_chat';
  return (
    <span
      className={`mt-0.5 inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-px text-[11px] font-medium leading-[18px] ${
        isMain
          ? 'bg-accent-soft text-accent'
          : 'border border-border bg-elevated text-text-secondary'
      }`}
    >
      <span
        className={`h-1.5 w-1.5 shrink-0 rounded-full ${
          isMain ? 'bg-accent' : 'bg-text-tertiary'
        }`}
      />
      {label}
    </span>
  );
}

/** 元数据行：仅 时间 · agent；出错时追加错误简述。
 *  token / 调用计数 / 模型这些细节进了详情才看，列表只服务"扫描定位"。 */
function MetaLine({ round: r }: { round: RoundSummary }) {
  return (
    <div className="mt-0.5 flex items-center gap-x-1.5 truncate text-[11px] text-text-tertiary">
      <span className="font-mono tabular-nums">{fmtClockTime(r.startTs)}</span>
      {/* agentName 后台 oneShot 调用可能为空——空则连分隔点一起省，不留孤立的「· 」 */}
      {r.agentName ? (
        <>
          <Sep />
          <span>{r.agentName}</span>
        </>
      ) : null}
      {r.errorMessage ? (
        <>
          <Sep />
          <span className="text-danger">{truncate(r.errorMessage, 40)}</span>
        </>
      ) : null}
    </div>
  );
}

function Sep() {
  return <span className="text-border-strong">·</span>;
}

/** 耗时列——总耗时 / 进行中（脉动绿） / 出错（红） */
function DurationCell({ round: r }: { round: RoundSummary }) {
  const { t } = useTranslation('debug');
  const isRunning = r.durationMs === undefined && !r.hadError;
  const isError = !!r.hadError;
  let text: string;
  let cls: string;
  if (isRunning) {
    text = t('roundList.running');
    cls = 'text-success animate-pulse';
  } else if (isError) {
    text = r.durationMs !== undefined ? fmtDuration(r.durationMs) : t('roundList.interrupted');
    cls = 'text-danger';
  } else {
    text = fmtDuration(r.durationMs);
    cls = 'text-text-primary';
  }
  return (
    <div className="shrink-0 pt-0.5 text-right">
      <div className={`font-mono text-base font-medium tabular-nums ${cls}`}>{text}</div>
    </div>
  );
}

function fmtClockTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
