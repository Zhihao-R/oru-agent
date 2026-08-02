/**
 * 对话期 Subagent（v2）终态完成行（2026-07-30 拍板：完成卡降级为工具行形态）。
 *
 * 完成行 = 无边框脚注行，复刻 ToolCallLine 的语言：状态点（完成绿/失败红，失败不配文字）
 * → GitFork 描边线性 icon（rotate-90）→ mono 标题，hover 浅底。摘要行整块移除——
 * 结果由主 agent 的综合答复承载，完成行不是给用户读的内容。
 * 详情 = 点击开行外 Dialog 浮层（复刻 ToolCallDetailDialog）：头部 = subagent 徽章 +
 * mono 标题 + 耗时 + 状态点；内容 = 派工 prompt / 内部对话（按 taskId 懒加载 sidecar）/
 * 返回 finalText（失败给 errorMessage，danger 色）/ Token。
 *
 * 运行中（含等审批）由底部 SubagentBar 承载、不进流——本组件只渲染终态。
 * 相邻 ≥2 条终态由 SubagentGroup 收成「N 个 subagent」折叠行（ChatArea items 层分组）。
 * 视觉真源：docs/superpowers/mockups/2026-07-30-subagent完成卡去摘要-demo.html（④ 工具行）。
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, GitFork } from 'lucide-react';
import { motion } from 'framer-motion';
import type { ChatMessage } from '@shared/types';
import { cn } from '@/lib/cn';
import { wsClient } from '@/lib/ws';
import { isTerminalSubagentMessage } from '@/lib/foldSubagentGroups';
import { useAgentStore } from '@/stores/agentStore';
import { ChatMessage as ChatMessageView } from './ChatMessage';
import { Dialog } from '../ui/Dialog';

type Props = { message: ChatMessage };

/**
 * 共享终态完成行（状态点 → fork icon → mono 标题，点击上详情）。sync（对话期 subagent）
 * 与 async（后台 SubagentTask）完成行共用这一份视觉真源，避免两处各写一份漂移
 * （2026-08-02 方案改动点5）。调用方自备详情浮层。
 */
export function SubagentCompletionRow({
  failed,
  title,
  onClick,
  ariaLabel,
}: {
  failed: boolean;
  title: string;
  onClick: () => void;
  ariaLabel: string;
}) {
  return (
    <motion.button
      type="button"
      initial={{ opacity: 0, y: 2 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      onClick={onClick}
      aria-label={ariaLabel}
      className="flex items-center gap-2 self-start rounded-xs px-1 py-0.5 text-left transition-colors duration-150 hover:bg-hover"
    >
      <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', failed ? 'bg-danger' : 'bg-success')} />
      <GitFork size={11} strokeWidth={2} className="shrink-0 rotate-90 text-text-tertiary" />
      <span
        className={cn(
          'max-w-[380px] truncate font-mono text-xs',
          failed ? 'text-danger' : 'text-text-tertiary',
        )}
      >
        {title}
      </span>
    </motion.button>
  );
}

/** 终态完成行：状态点 → fork icon → mono 标题；点击上详情浮层。非终态不渲染（归 SubagentBar）。 */
export function SubagentChip({ message }: Props) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  if (!isTerminalSubagentMessage(message)) return null;
  const ref = message.subagent;
  const failed = ref.status === 'error';

  return (
    <>
      <SubagentCompletionRow
        failed={failed}
        title={ref.description}
        onClick={() => setOpen(true)}
        ariaLabel={t('subagent.aria', { name: ref.description })}
      />
      <SubagentDetailDialog message={message} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/**
 * 相邻终态完成行的折叠组（2026-07-30 拍板）：≥2 条收成一行「N 个 subagent」
 * （chevron + 计数，不带状态——与工具折叠同规矩），点开逐行；单条直接渲染完成行。
 */
export function SubagentGroup({ messages }: { messages: ChatMessage[] }) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  if (messages.length === 1) return <SubagentChip message={messages[0]} />;
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 self-start rounded-xs px-1 py-0.5 text-xs text-text-tertiary transition-colors duration-150 hover:text-text-secondary"
      >
        <ChevronRight
          size={12}
          strokeWidth={1.5}
          className={cn('transition-transform duration-150', expanded && 'rotate-90')}
        />
        {expanded ? t('message.collapse') : t('message.subagentFold', { count: messages.length })}
      </button>
      {expanded ? messages.map((m) => <SubagentChip key={m.id} message={m} />) : null}
    </div>
  );
}

/** 耗时（终态才有）：completedAt - startedAt，设计稿工具卡头的 0.4s 样式 */
function elapsedOf(startedAt: number, completedAt?: number): string | null {
  if (completedAt == null) return null;
  return `${((completedAt - startedAt) / 1000).toFixed(1)}s`;
}

/**
 * 详情浮层：头部 = subagent 徽章 + mono 标题 + 耗时 + 状态点（工具详情卡头语言），
 * 内容 = 派工 / 内部对话（懒加载）/ 返回（或失败原因）/ Token。调用方保证终态。
 */
function SubagentDetailDialog({
  message,
  open,
  onClose,
}: {
  message: ChatMessage;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('chat');
  const ref = message.subagent;
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const [innerMessages, setInnerMessages] = useState<ChatMessage[] | null>(null);
  const [loading, setLoading] = useState(false);

  // 懒加载 sidecar：浮层首次打开才拉，成功才置 loaded 标志（终态 sidecar 已冻结，不必重拉）；
  // 失败 / 被取消不置标志，下次打开自然重试。标志用 ref 而非 innerMessages 入依赖——
  // 数据落地触发的 effect 重跑会把在途请求 cancelled 掉，finally 里的 setLoading(false)
  // 被跳过，浮层永远停在「加载中」。
  const loadedRef = useRef(false);
  useEffect(() => {
    if (!open || !ref || !activeAgentId || loadedRef.current) return;
    let cancelled = false;
    setLoading(true);
    void wsClient
      .request({
        type: 'conv.getSubagentSidecar',
        agentId: activeAgentId,
        conversationId: message.conversationId,
        taskId: ref.taskId,
      })
      .then((resp) => {
        if (cancelled) return;
        if (resp.type === 'conv.subagentSidecar.result') {
          loadedRef.current = true;
          setInnerMessages(resp.messages);
        }
      })
      .catch(() => {
        if (!cancelled) setInnerMessages([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, ref, message.conversationId, activeAgentId]);

  if (!ref) return null;
  const failed = ref.status === 'error';
  const elapsed = elapsedOf(ref.startedAt, ref.completedAt);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      className="w-[min(640px,calc(100vw-32px))]"
      title={
        <span className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded bg-accent-soft px-1.5 py-0.5 font-mono text-2xs font-medium text-accent">
            <GitFork size={11} strokeWidth={2} className="rotate-90" />
            subagent
          </span>
          <span className="font-mono text-sm text-text-primary">{ref.description}</span>
          {elapsed ? <span className="text-xs text-text-tertiary">{elapsed}</span> : null}
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', failed ? 'bg-danger' : 'bg-success')} />
        </span>
      }
    >
      <div className="max-h-[60vh] overflow-y-auto text-xs text-text-secondary">
        <Section title={t('subagent.sectionPrompt')}>
          <pre className="whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
            {ref.prompt}
          </pre>
        </Section>

        <Section title={t('subagent.sectionInner')}>
          {loading ? (
            <div className="text-text-secondary">{t('common:loading')}</div>
          ) : innerMessages && innerMessages.length > 0 ? (
            <div className="space-y-2">
              {innerMessages.map((m) => (
                <ChatMessageView key={m.id} message={m} />
              ))}
            </div>
          ) : (
            <div className="text-text-secondary">{t('subagent.noInnerSteps')}</div>
          )}
        </Section>

        {ref.status === 'completed' && ref.finalText ? (
          <Section title={t('subagent.sectionFinal')}>
            <pre className="whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
              {ref.finalText}
            </pre>
          </Section>
        ) : null}

        {failed && ref.errorMessage ? (
          <Section title={t('subagent.sectionError')}>
            <pre className="whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed text-danger">
              {ref.errorMessage}
            </pre>
          </Section>
        ) : null}

        {/* tokenUsage 成败都落盘（runner 无条件写入），demo 浮层 Token 段也不分成败 */}
        {ref.tokenUsage ? (
          <Section title="Token">
            <span className="text-text-secondary">
              in {ref.tokenUsage.input} / out {ref.tokenUsage.output}
              {ref.tokenUsage.cacheRead > 0 ? ` / cache ${ref.tokenUsage.cacheRead}` : ''}
            </span>
          </Section>
        ) : null}
      </div>
    </Dialog>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{title}</div>
      {children}
    </div>
  );
}
