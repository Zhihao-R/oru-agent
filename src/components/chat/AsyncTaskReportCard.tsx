/**
 * 后台异步 subagent 终态完成行（2026-08-02 拍板：async 完成卡由大绿卡改 simple 完成行）。
 *
 * task-report 消息在主对话 jsonl 里保留（主 agent 下一回合读 summary 汇报），这里只改渲染：
 * - 完成行 = 共享 SubagentCompletionRow（状态点 → fork icon → mono 标题）——与 sync 同款，
 *   无回滚按钮；失败态也不留大绿卡，统一走「完成行 + 详情」（用户 2026-08-02 拍板）。
 * - 标题/状态从 SubagentTask（tasks[taskId]）取；task 缺失（重载后 tasks 为空、task-report
 *   落盘仍在流中）时降级用 summary 剥 emoji 前缀行兜标题、默认绿 done——完成行永不空白。
 * - 详情 Dialog 数据源是 SubagentTask（summary/errorMessage/affectedPaths）；async 内部对话
 *   在 task_${taskId} 一次性 conversation，不写 sidecar，这里不提供内部对话段。
 * 视觉真源：docs/superpowers/mockups/2026-07-30-subagent完成卡去摘要-demo.html（④ 工具行）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { GitFork } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useTaskStore } from '@/stores/taskStore';
import { Dialog } from '../ui/Dialog';
import { SubagentCompletionRow } from './SubagentChip';

type Props = {
  taskId: string;
  /** task-report 消息的 summary 全文（重载后 task 缺失时的兜底与详情降级） */
  summary: string;
};

/** 取 composeReportText 首行「$\{prefix\} 标题」里的标题（剥 emoji 前缀），降级兜底用，纯函数 */
export function parseReportTitle(summary: string, fallback: string): string {
  const firstLine = summary.split('\n').find((l) => l.trim().length > 0);
  if (!firstLine) return fallback;
  const title = firstLine.replace(/^[✅❌↩⛔]\s*/, '').trim();
  return title || fallback;
}

/** 重载后 task 缺失时，据 summary 前缀 emoji 派生成败（供状态点染色） */
function reportFailedFromSummary(summary: string): boolean {
  return /^❌/.test(summary);
}

export function AsyncTaskReportCard({ taskId, summary }: Props) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const task = useTaskStore((s) => s.tasks[taskId]);

  const fallback = t('subagent.asyncTaskName');
  const title = task?.proposalTitle ?? parseReportTitle(summary, fallback);
  const failed = task ? task.status === 'failed' : reportFailedFromSummary(summary);

  return (
    <>
      <SubagentCompletionRow
        failed={failed}
        title={title}
        onClick={() => setOpen(true)}
        ariaLabel={t('subagent.aria', { name: title })}
      />
      <AsyncTaskDetailDialog taskId={taskId} summary={summary} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function AsyncTaskDetailDialog({
  taskId,
  summary,
  open,
  onClose,
}: {
  taskId: string;
  summary: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation('chat');
  const task = useTaskStore((s) => s.tasks[taskId]);
  const fallback = t('subagent.asyncTaskName');
  const title = task?.proposalTitle ?? parseReportTitle(summary, fallback);
  const failed = task ? task.status === 'failed' : reportFailedFromSummary(summary);
  const elapsed =
    task?.startedAt != null && task?.finishedAt != null
      ? `${((task.finishedAt - task.startedAt) / 1000).toFixed(1)}s`
      : null;

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
          <span className="font-mono text-sm text-text-primary">{title}</span>
          {elapsed ? <span className="text-xs text-text-tertiary">{elapsed}</span> : null}
          <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', failed ? 'bg-danger' : 'bg-success')} />
        </span>
      }
    >
      <div className="max-h-[60vh] overflow-y-auto text-xs text-text-secondary">
        {task ? (
          <>
            {task.status === 'done' && task.summary ? (
              <Section title={t('subagent.sectionFinal')}>
                <pre className="whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
                  {task.summary}
                </pre>
              </Section>
            ) : null}
            {failed && task.errorMessage ? (
              <Section title={t('subagent.sectionError')}>
                <pre className="whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed text-danger">
                  {task.errorMessage}
                </pre>
              </Section>
            ) : null}
            {task.affectedPaths.length > 0 ? (
              <Section title={t('subagent.sectionPaths')}>
                <ul className="list-inside list-disc space-y-1">
                  {task.affectedPaths.map((p) => (
                    <li key={p} className="font-mono text-xs text-text-primary">{p}</li>
                  ))}
                </ul>
              </Section>
            ) : null}
            {/* async 内部对话在一次性 task_${taskId} conversation，不写 sidecar——无内部步骤 */}
            <Section title={t('subagent.sectionInner')}>
              <div className="text-text-secondary">{t('subagent.noInnerSteps')}</div>
            </Section>
          </>
        ) : (
          // 重载后 task 缺失：详情降级为只读 summary 全文（不抛错、不空白）
          <Section title={t('subagent.sectionFinal')}>
            <pre className="whitespace-pre-wrap break-words rounded-xs border border-border bg-sunken/40 px-3 py-2 font-mono text-xs leading-relaxed text-text-primary">
              {summary}
            </pre>
          </Section>
        )}
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
