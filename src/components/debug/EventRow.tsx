/**
 * 时间线一行——精简列：图标 / 名字描述 / 耗时 / token / model+状态
 *
 * 跟旧版差异：
 * - 去掉"相对时间"列（PRD §2.2 — 排查场景里是噪音）
 * - 耗时全用秒（fmtDuration），不出现 ms / m 复合
 *
 * 节点的 relMs 从 buildTimelineModel 的合并节点读，不再从 record.relMs 读——
 * 这样并发组与子工具的时序锚点对齐到 start，未来加 tooltip 可直接用 event.relMs。
 */
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import {
  User,
  FileText,
  Brain,
  Wrench,
  MessageCircle,
  AlertCircle,
  CheckCircle2,
  CircleAlert,
  Eye,
} from 'lucide-react';
import type { DebugPayloadMap } from '@shared/debug/types';
import type { TimelineEvent } from '@/lib/buildTimelineModel';
import { fmtDuration } from '@/lib/fmtDuration';
import { TIMELINE_COLS } from './timelineLayout';

export function EventRow({
  event,
  selected,
  onClick,
  indented,
}: {
  event: TimelineEvent;
  selected: boolean;
  onClick: () => void;
  indented?: boolean;
}) {
  const { t } = useTranslation('debug');
  const cells = renderCells(event, t);
  return (
    <button
      type="button"
      onClick={onClick}
      className={`grid w-full cursor-pointer ${TIMELINE_COLS} items-center gap-3 border-b border-border px-3 py-1.5 text-left text-sm transition-colors ${
        selected ? 'bg-accent-soft' : 'hover:bg-hover'
      } ${indented ? 'pl-8' : ''}`}
    >
      <span className="flex items-center justify-center">{cells.icon}</span>
      <span className="truncate text-text-primary">{cells.name}</span>
      <span className="font-mono text-xs text-text-secondary tabular-nums">{cells.duration}</span>
      <span className="font-mono text-xs text-text-tertiary tabular-nums">{cells.tokens}</span>
      <span className="truncate text-xs text-text-tertiary">{cells.modelOrStatus}</span>
    </button>
  );
}

interface Cells {
  icon: ReactNode;
  name: ReactNode;
  duration: ReactNode;
  tokens: ReactNode;
  modelOrStatus: ReactNode;
}

function renderCells(event: TimelineEvent, t: TFunction): Cells {
  const { record, displayType, unfinished } = event;
  switch (displayType) {
    case 'round_start': {
      const p = record.payload as DebugPayloadMap['round_start'];
      return {
        icon: <User size={14} strokeWidth={1.5} className="text-accent" />,
        name: <span className="font-medium">{t('event.userInput')}</span>,
        duration: '',
        tokens: '',
        modelOrStatus: (
          <span className="truncate text-text-secondary">
            {p.userText.slice(0, 60)}
            {p.userText.length > 60 ? '…' : ''}
          </span>
        ),
      };
    }
    case 'prompt_built': {
      // prompt_built 没有 token 用量（chars 不是 token），把 system size / history 数放进 modelOrStatus 列
      const p = record.payload as DebugPayloadMap['prompt_built'];
      return {
        icon: <FileText size={14} strokeWidth={1.5} className="text-text-tertiary" />,
        name: <span>{t('event.promptBuilt')}</span>,
        duration: fmtDuration(p.durationMs),
        tokens: '',
        modelOrStatus: (
          <span className="truncate text-xs">
            system {(p.systemContextChars / 1024).toFixed(1)}k chars
          </span>
        ),
      };
    }
    case 'inference_view': {
      // v0.5：adapter 输出归档（真实入参）。一行 summary 表达"裁了多少 / 是否跑了 adapter"，
      // 详情区按 wireHistory 渲染。
      const p = record.payload as DebugPayloadMap['inference_view'];
      const s = p.savings;
      const totalCut = s.systemMessagesFiltered + s.persistedReplaced + s.writeAckDeduped;
      const status = !p.adapterRan
        ? t('row.infNotRun')
        : !p.enabled
          ? t('row.infNotEnabled')
          : totalCut === 0
            ? t('row.infNoCut')
            : t('row.infCut', { count: totalCut });
      return {
        icon: <Eye size={14} strokeWidth={1.5} className="text-text-tertiary" />,
        name: <span>{t('event.inferenceView')}</span>,
        duration: '',
        tokens: '',
        modelOrStatus: <span className="truncate text-xs">{status}</span>,
      };
    }
    case 'llm_call': {
      if (unfinished) {
        const p = record.payload as DebugPayloadMap['llm_call_start'];
        return {
          icon: <Brain size={14} strokeWidth={1.5} className="text-warn" />,
          name: <span>{t('event.llmCallN', { n: p.callIndex })}</span>,
          duration: '—',
          tokens: '',
          modelOrStatus: <span className="text-warn">{t('row.unfinished')}</span>,
        };
      }
      const p = record.payload as DebugPayloadMap['llm_call_done'];
      // 推理 token 非 0 时追加「思考 N」——让"out 极小但耗时长"的截断场景一眼可读
      const thinkingSuffix =
        p.reasoningTokens !== undefined && p.reasoningTokens > 0
          ? ` (${t('row.thinking', { n: formatNum(p.reasoningTokens) })})`
          : '';
      const outPart =
        p.outputTokens !== undefined ? ` · out ${formatNum(p.outputTokens)}${thinkingSuffix}` : '';
      const tokenStr =
        p.inputTokens !== undefined
          ? `in ${formatNum(p.inputTokens)}${outPart}`
          : p.firstTokenMs !== undefined
            ? t('row.firstToken', { dur: fmtDuration(p.firstTokenMs) })
            : '';
      // length / content_filter 等非正常终止——输出被截断的强信号
      const truncatedReason =
        p.finishReason && p.finishReason !== 'stop' && p.finishReason !== 'tool_calls'
          ? p.finishReason
          : undefined;
      return {
        icon: (
          <Brain
            size={14}
            strokeWidth={1.5}
            className={truncatedReason ? 'text-danger' : 'text-accent'}
          />
        ),
        name: (
          <span>
            {t('event.llmCallN', { n: p.callIndex })}
            {truncatedReason ? (
              <span className="ml-1 text-danger">· {t('row.truncated', { reason: truncatedReason })}</span>
            ) : null}
          </span>
        ),
        duration: fmtDuration(p.durationMs),
        tokens: tokenStr,
        modelOrStatus:
          p.firstTokenMs !== undefined && p.inputTokens !== undefined ? (
            <span className="truncate">{t('row.firstToken', { dur: fmtDuration(p.firstTokenMs) })}</span>
          ) : (
            ''
          ),
      };
    }
    case 'tool_call': {
      if (unfinished) {
        const p = record.payload as DebugPayloadMap['tool_call_start'];
        return {
          icon: <Wrench size={14} strokeWidth={1.5} className="text-warn" />,
          name: <span className="truncate">{p.name}</span>,
          duration: '—',
          tokens: '',
          modelOrStatus: <span className="text-warn">{t('row.unfinished')}</span>,
        };
      }
      const p = record.payload as DebugPayloadMap['tool_call_done'];
      return {
        icon: p.isError
          ? <CircleAlert size={14} strokeWidth={1.5} className="text-danger" />
          : <Wrench size={14} strokeWidth={1.5} className="text-success" />,
        name: <span className="truncate">{toolName(event, t)}</span>,
        duration: fmtDuration(p.durationMs),
        tokens: '',
        modelOrStatus: p.isError ? <span className="text-danger">{t('row.failed')}</span> : <span className="text-success">{t('row.done')}</span>,
      };
    }
    case 'final_answer': {
      const p = record.payload as DebugPayloadMap['final_answer'];
      return {
        icon: <MessageCircle size={14} strokeWidth={1.5} className="text-accent" />,
        name: <span className="font-medium">{t('event.finalAnswer')}</span>,
        duration: fmtDuration(p.totalDurationMs),
        tokens: `in ${formatNum(p.totalInputTokens)} · out ${formatNum(p.totalOutputTokens)}`,
        modelOrStatus: <span className="truncate">{p.finalModel ?? '—'}</span>,
      };
    }
    case 'error': {
      const p = record.payload as DebugPayloadMap['error'];
      return {
        icon: <AlertCircle size={14} strokeWidth={1.5} className="text-danger" />,
        name: <span className="text-danger">{t('row.errorPrefix', { message: p.message.slice(0, 80) })}</span>,
        duration: '',
        tokens: p.phase,
        modelOrStatus: '',
      };
    }
    default:
      return {
        icon: <CheckCircle2 size={14} strokeWidth={1.5} className="text-text-tertiary" />,
        name: <span className="text-text-tertiary">{displayType}</span>,
        duration: '',
        tokens: '',
        modelOrStatus: '',
      };
  }
}

function toolName(event: TimelineEvent, t: TFunction): string {
  // tool_call_done 没有 name，从 toolMeta 取（buildTimelineModel 在合并时扁平化过去）。name 是工具标识符（数据），不翻
  if (event.toolMeta) return event.toolMeta.name;
  // fallback：用 toolCallId 兜底（理论上不会触发——start 缺失时 toolMeta 也没有）
  const p = event.record.payload as DebugPayloadMap['tool_call_done'];
  return t('row.toolFallback', { id: p.toolCallId.slice(0, 8) });
}

function formatNum(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
