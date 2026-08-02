import { useTranslation } from 'react-i18next';
import { Square, RotateCcw } from 'lucide-react';
import type { ChatMessage } from '@shared/types';
import { normalizeToolName } from '@shared/agent/toolName';
import { derivePhase } from '@/lib/streamPhase';
import { cn } from '@/lib/cn';

const MAX_RETRIES = 5;

export function StreamStatusBar({
  message,
  onStop,
  onRetry,
}: {
  message: ChatMessage;
  onStop: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation('chat');
  const phase = derivePhase(message);
  if (phase === 'done') return null;

  // 终态：aborted / errored
  if (phase === 'aborted') {
    return (
      <StatusRow
        tone="muted"
        label={t('status.aborted')}
        action={
          <StatusButton onClick={onRetry} label={t('status.retry')}>
            <RotateCcw size={11} strokeWidth={1.8} />
          </StatusButton>
        }
      />
    );
  }
  if (phase === 'errored') {
    const err = message.error!;
    return (
      <StatusRow
        tone="danger"
        label={t('status.errored', { message: err.message })}
        action={
          err.retryable ? (
            <StatusButton onClick={onRetry} label={t('status.retry')}>
              <RotateCcw size={11} strokeWidth={1.8} />
            </StatusButton>
          ) : null
        }
      />
    );
  }

  // 进行中态：thinking / tool / output / retrying
  const indicator = phase === 'thinking' ? <ThreeDots /> : <PulseDot />;
  const label =
    phase === 'thinking'
      ? t('status.thinking')
      : phase === 'tool'
        ? t('status.callingTool', { tool: runningToolName(message) })
        : phase === 'retrying'
          ? t('status.retrying', { attempt: message.retryAttempt, max: MAX_RETRIES })
          : t('status.outputting');

  return (
    <StatusRow
      tone="muted"
      label={
        <span className="flex items-center gap-2">
          {indicator}
          <span>{label}</span>
        </span>
      }
      action={
        <StatusButton onClick={onStop} label={t('status.stop')}>
          <Square size={9} strokeWidth={1.8} fill="currentColor" />
        </StatusButton>
      }
    />
  );
}

/**
 * 状态行操作按钮：20px 描边白底圆（图标 + tooltip，hover 危险色）。
 * 圆形走「单枚小图标按钮」约定，见设计词汇表 §3（docs/tech/2026-07-15-ui-ux-设计词汇表.md）。
 */
function StatusButton({
  onClick,
  label,
  children,
}: {
  onClick: () => void;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border-strong bg-elevated text-text-secondary transition-colors hover:border-danger hover:text-danger"
    >
      {children}
    </button>
  );
}

function StatusRow({
  tone,
  label,
  action,
}: {
  tone: 'muted' | 'danger';
  label: React.ReactNode;
  action: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        'flex items-center justify-between gap-2 text-xs',
        tone === 'muted' ? 'text-text-tertiary' : 'text-danger',
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      {action}
    </div>
  );
}

function runningToolName(msg: ChatMessage): string {
  const t = msg.toolCalls.find((tc) => tc.status === 'running');
  // claude-code 事件名带 mcp__oru__ 前缀——状态行剥前缀，不露内部代号
  return t ? normalizeToolName(t.name) : 'tool';
}

function ThreeDots() {
  return (
    <span className="flex gap-1">
      <span className="h-1 w-1 animate-pulse rounded-full bg-text-tertiary [animation-delay:0ms]" />
      <span className="h-1 w-1 animate-pulse rounded-full bg-text-tertiary [animation-delay:150ms]" />
      <span className="h-1 w-1 animate-pulse rounded-full bg-text-tertiary [animation-delay:300ms]" />
    </span>
  );
}

function PulseDot() {
  return (
    <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
  );
}
