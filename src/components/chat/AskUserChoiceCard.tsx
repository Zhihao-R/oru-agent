/**
 * 「带选项提问」卡（ask_user_choice）——对话内联，跟着文本往下排。
 *
 * 两种形态：
 * - AskUserChoiceCard：待答的交互卡（顶部问题 tab + 合并翻页 + 单/多选 + 我自己说 + 提交）。
 * - AskUserChoiceSummary：答完 / replay 的只读小结（从完成的 toolCall.result.structured 重建）。
 *
 * 颜色全用主题 token（--accent / --accent-soft / --bg-* / --border-* / --text-*），换肤 / 深色自动跟随。
 * --accent-fg 不经 tailwind 暴露，按项目惯例用 inline style 绑（见 UserBubble）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import { ChevronLeft, ChevronRight, Check } from 'lucide-react';
import type {
  AskUserChoiceAnswerItem,
  AskUserChoiceQuestion,
  ToolCall,
} from '@shared/types';
import { cn } from '@/lib/cn';
import { useChatStore, type AskUserChoicePending } from '@/stores/chatStore';

type PendingAsk = Pick<AskUserChoicePending, 'askId' | 'questions' | 'disabled'> & {
  /** 睡眠唤醒恢复的「放弃此题」出口（sleep-wake-chat-recovery §6）：卡被禁用（中断/睡眠恢复后
   *  半截在途、用户在等人答）时可点放弃 → abort 该对话、释放回合。undefined = 正常待答态不显示。
   *  由 PendingDecisionDock 用该卡所在对话的 conversationId 注入。 */
  conversationId?: string;
};

type QDraft = { selectedLabels: string[]; freeText: string; otherOn: boolean };

function isAnswered(d: QDraft): boolean {
  return d.selectedLabels.length > 0 || (d.otherOn && d.freeText.trim().length > 0);
}

function draftToAnswer(d: QDraft, index: number): AskUserChoiceAnswerItem {
  if (d.otherOn && d.freeText.trim()) return { questionIndex: index, freeText: d.freeText.trim() };
  if (d.selectedLabels.length > 0) return { questionIndex: index, selectedLabels: d.selectedLabels };
  return { questionIndex: index, skipped: true };
}

export function AskUserChoiceCard({ ask }: { ask: PendingAsk }) {
  const { t } = useTranslation('chat');
  const answerUserChoice = useChatStore((s) => s.answerUserChoice);
  const abort = useChatStore((s) => s.abort);
  const { questions } = ask;
  const [cur, setCur] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [confirmGiveUp, setConfirmGiveUp] = useState(false);
  const [drafts, setDrafts] = useState<QDraft[]>(() =>
    questions.map(() => ({ selectedLabels: [], freeText: '', otherOn: false })),
  );

  const total = questions.length;
  const q = questions[cur];
  const d = drafts[cur];
  const isLast = cur === total - 1;
  const locked = ask.disabled || submitting;

  const patch = (i: number, next: Partial<QDraft>) =>
    setDrafts((ds) => ds.map((x, j) => (j === i ? { ...x, ...next } : x)));

  const pickOption = (label: string) => {
    if (locked) return;
    if (q.multiSelect) {
      const has = d.selectedLabels.includes(label);
      patch(cur, {
        selectedLabels: has ? d.selectedLabels.filter((l) => l !== label) : [...d.selectedLabels, label],
        otherOn: false,
        freeText: '',
      });
    } else {
      patch(cur, { selectedLabels: [label], otherOn: false, freeText: '' });
    }
  };

  const pickOther = () => {
    if (locked) return;
    patch(cur, { otherOn: true, selectedLabels: [] });
  };

  const submit = async () => {
    if (locked) return;
    setSubmitting(true);
    const answers = drafts.map(draftToAnswer);
    try {
      await answerUserChoice(ask.askId, { answers });
      // 成功后本卡被 store 移除（只读小结由随即到达的 toolResult 承载），无需复位
    } catch {
      setSubmitting(false); // WS 失败：卡片保留，复位提交态让用户重试
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={cn(
        'overflow-hidden rounded-lg border border-border bg-elevated shadow-soft',
        ask.disabled && 'pointer-events-none opacity-50',
      )}
    >
      {/* 顶部：问题 tab + 右上合并翻页器 */}
      <div className="flex items-center gap-0.5 border-b border-border bg-sunken px-2.5 pt-1.5">
        {questions.map((qq, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setCur(i)}
            className={cn(
              'flex items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 pb-2.5 pt-2 text-sm font-medium transition-colors',
              i === cur ? 'text-text-primary' : 'text-text-tertiary hover:text-text-secondary',
            )}
            style={i === cur ? { borderBottomColor: 'var(--accent)' } : undefined}
          >
            <span
              className={cn(
                'grid h-3.5 w-3.5 place-items-center rounded-full border',
                isAnswered(drafts[i]) ? 'border-transparent text-[var(--accent-fg)]' : 'border-border-strong',
              )}
              style={isAnswered(drafts[i]) ? { background: 'var(--accent)' } : undefined}
            >
              {isAnswered(drafts[i]) ? <Check size={9} strokeWidth={3} /> : null}
            </span>
            {qq.header}
          </button>
        ))}
        <span className="ml-auto flex items-center gap-0.5 pb-1">
          {total > 1 ? (
            <button
              type="button"
              disabled={cur === 0}
              onClick={() => setCur((c) => Math.max(0, c - 1))}
              className="grid h-6 w-6 place-items-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronLeft size={15} />
            </button>
          ) : null}
          <span className="min-w-[2rem] text-center text-sm tabular-nums text-text-tertiary">
            {cur + 1} / {total}
          </span>
          {total > 1 ? (
            <button
              type="button"
              disabled={isLast}
              onClick={() => setCur((c) => Math.min(total - 1, c + 1))}
              className="grid h-6 w-6 place-items-center rounded text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-40 disabled:hover:bg-transparent"
            >
              <ChevronRight size={15} />
            </button>
          ) : null}
        </span>
      </div>

      {/* 题面 + 选项 */}
      <div className="px-4 pb-1 pt-4">
        <div className="mb-3 text-md font-medium text-text-primary">
          {q.question}
          {q.multiSelect ? <span className="ml-1 text-text-tertiary">{t('askChoice.multiHint')}</span> : null}
        </div>
        <div className="flex flex-col gap-2">
          {q.options.map((opt) => {
            const sel = d.selectedLabels.includes(opt.label);
            return (
              <Option
                key={opt.label}
                selected={sel}
                multi={!!q.multiSelect}
                onClick={() => pickOption(opt.label)}
              >
                <div className="text-base font-semibold text-text-primary">{opt.label}</div>
                {opt.description ? (
                  <div className="mt-0.5 text-sm leading-relaxed text-text-secondary">{opt.description}</div>
                ) : null}
              </Option>
            );
          })}
          {/* 「我自己说」逃生口（前端追加，不进 schema） */}
          <Option selected={d.otherOn} multi={!!q.multiSelect} align="center" onClick={pickOther}>
            <input
              className="w-full bg-transparent text-base text-text-primary outline-none placeholder:text-text-tertiary"
              placeholder={t('askChoice.otherPlaceholder')}
              value={d.freeText}
              disabled={locked}
              onFocus={pickOther}
              onChange={(e) => patch(cur, { otherOn: true, selectedLabels: [], freeText: e.target.value })}
            />
          </Option>
        </div>
      </div>

      {/* 底部右下角单个主操作按钮 */}
      <div className="flex items-center justify-end gap-2 px-4 pb-3.5 pt-1">
        {/* 睡眠唤醒恢复的「放弃此题」出口：卡被禁用（不是用户正在答的活卡）且该对话可中止时，
            放次级位置的「放弃」——避免用户误触中断正常进行的回合（M1 视觉降级）。点两次（轻确认）。 */}
        {ask.disabled && ask.conversationId ? (
          confirmGiveUp ? (
            <button
              type="button"
              onClick={() => abort(ask.conversationId!)}
              onBlur={() => setConfirmGiveUp(false)}
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium text-warn-deep transition-colors hover:bg-hover"
            >
              {t('askChoice.giveUpConfirm')}
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmGiveUp(true)}
              className="rounded-md border border-border-strong px-3 py-1.5 text-sm font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
            >
              {t('askChoice.giveUp')}
            </button>
          )
        ) : null}
        {isLast ? (
          <button
            type="button"
            disabled={locked}
            onClick={() => void submit()}
            className="rounded-md px-5 py-2 text-base font-medium transition-[filter] hover:brightness-95 disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            {t('askChoice.submit')}
          </button>
        ) : (
          <button
            type="button"
            disabled={locked}
            onClick={() => setCur((c) => Math.min(total - 1, c + 1))}
            className="rounded-md border border-border-strong px-4 py-1.5 text-base font-medium text-text-secondary transition-colors hover:bg-hover hover:text-text-primary disabled:opacity-50"
          >
            {t('askChoice.next')}
          </button>
        )}
      </div>
    </motion.div>
  );
}

function Option({
  selected,
  multi,
  align = 'start',
  onClick,
  children,
}: {
  selected: boolean;
  multi: boolean;
  align?: 'start' | 'center';
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      onClick={onClick}
      className={cn(
        'flex cursor-pointer gap-3 rounded-md border px-3 py-2.5 transition-colors',
        align === 'center' ? 'items-center' : 'items-start',
        selected ? 'border-[var(--accent)] bg-accent-soft' : 'border-border hover:border-border-strong hover:bg-hover',
      )}
    >
      <span
        className={cn(
          'relative mt-0.5 h-4 w-4 flex-none border-[1.5px]',
          multi ? 'rounded-[5px]' : 'rounded-full',
          selected ? 'border-[var(--accent)]' : 'border-border-strong',
        )}
        style={selected ? { background: 'var(--accent)' } : undefined}
      >
        {selected ? (
          multi ? (
            <Check size={11} strokeWidth={3} className="absolute inset-0 m-auto" style={{ color: 'var(--accent-fg)' }} />
          ) : (
            <span className="absolute inset-[3px] rounded-full" style={{ background: 'var(--accent-fg)' }} />
          )
        ) : null}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** 答完 / replay 的只读小结——从完成的 ask_user_choice toolCall 重建（input=问题、result.structured=回答） */
export function AskUserChoiceSummary({ tool }: { tool: ToolCall }) {
  const { t } = useTranslation('chat');
  const questions = (tool.input?.questions as AskUserChoiceQuestion[] | undefined) ?? [];
  const answers = (tool.result?.structured?.answers as AskUserChoiceAnswerItem[] | undefined) ?? [];
  if (questions.length === 0) return null;
  const byIndex = new Map(answers.map((a) => [a.questionIndex, a]));
  return (
    <div className="rounded-lg border border-border bg-sunken px-3.5 py-3">
      <div className="mb-2 text-xs text-text-tertiary">{t('askChoice.yourChoice')}</div>
      <div className="flex flex-col gap-3">
        {questions.map((q, i) => {
          const a = byIndex.get(i);
          let value: string;
          let muted = false;
          if (a?.freeText?.trim()) value = t('askChoice.saidPrefix', { text: a.freeText.trim() });
          else if (a?.selectedLabels && a.selectedLabels.length > 0)
            value = a.selectedLabels.join(t('askChoice.labelJoin'));
          else {
            value = t('askChoice.skipped');
            muted = true;
          }
          return (
            // 标题与答案上下两行：header 长度由模型决定（schema 只要求「短标题」、无上限），
            // 上下排是唯一对它无条件鲁棒的——曾并排在固定窄列里，长 header 被压成竖排
            <div key={i} className="text-base">
              <div className="text-text-tertiary">{q.header}</div>
              <div className={cn('font-medium', muted ? 'text-text-tertiary' : 'text-text-primary')}>{value}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
