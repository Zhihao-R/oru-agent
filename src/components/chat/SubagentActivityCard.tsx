/**
 * 对话内 subagent 运行态卡 —— 两条派工链路（后台 task / 对话期 subagent）共用的壳。
 *
 * 单列三行：顶行 subagent 标记 + 状态，中行标题，底行"当前在干什么"。
 * 不画进度条、不做计数（PRD 定的克制取舍：进度难以可信估计，宁可不画）。
 * 展开区由调用方传 children（后台 task 给 detail/cancel；对话期 subagent 给 prompt/sidecar）。
 *
 * 视觉真源：docs/demos/2026-06-09-subagent-activity-card.html
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, CheckCircle2, AlertCircle, Pause, GitFork, ChevronRight, ChevronDown } from 'lucide-react';
import type { SubagentActivity } from '@shared/types';
import { toolActivityText } from '@shared/agent/toolActivity';
import { cn } from '@/lib/cn';

export type ActivityCardStatus = 'running' | 'awaiting' | 'done' | 'failed';

// 状态词经 i18n 取（subagentCard.status.<status>）；图标/动效/颜色与文案分离
const STATUS: Record<ActivityCardStatus, { icon: typeof Loader2; spin: boolean; cls: string }> = {
  running: { icon: Loader2, spin: true, cls: 'text-text-tertiary' },
  awaiting: { icon: Pause, spin: false, cls: 'text-warn' },
  done: { icon: CheckCircle2, spin: false, cls: 'text-success' },
  failed: { icon: AlertCircle, spin: false, cls: 'text-danger' },
};

type Props = {
  title: string;
  status: ActivityCardStatus;
  /** 覆盖状态词；running 态可传任务 verb（生成中 / 查资料中 / 排队中…） */
  statusLabel?: string;
  /** 运行态底行 */
  activity?: SubagentActivity;
  /** 终态 / 等待态底行（摘要 / 问题 / 原因）；running 态优先 activity，其余态用本字段 */
  bottomText?: ReactNode;
  bottomError?: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggleExpand?: () => void;
  /** 展开区内容 */
  children?: ReactNode;
};

export function SubagentActivityCard({
  title,
  status,
  statusLabel,
  activity,
  bottomText,
  bottomError,
  expandable,
  expanded,
  onToggleExpand,
  children,
}: Props) {
  const { t } = useTranslation('chat');
  const st = STATUS[status];
  const Icon = st.icon;

  // 底行：运行态优先 activity，否则终态/等待态文本
  let bottom: ReactNode = null;
  if (status === 'running' && activity) {
    const dim = activity.source === 'tool';
    const text = dim ? toolActivityText(activity.toolName ?? '', activity.toolObject, t) : activity.text;
    bottom = (
      <div className="text-sm text-text-secondary">
        <span className={cn('block truncate', dim && 'text-text-tertiary')}>{text}</span>
      </div>
    );
  } else if (bottomText) {
    bottom = (
      <div className={cn('text-base leading-relaxed', bottomError ? 'text-danger' : 'text-text-secondary')}>
        {bottomText}
      </div>
    );
  }

  return (
    <div
      className={cn(
        // 活卡（运行中/等你确认）白底微投影，死态（完成/失败）降为普通边框无投影（设计稿活死态落差）
        // 宽度铺满消息列（2026-07-20 拍板：对话内卡片一律整行）
        'w-full self-start rounded-sm border bg-elevated',
        status === 'running' || status === 'awaiting'
          ? 'border-border-strong shadow-soft'
          : 'border-border',
      )}
    >
      <button
        type="button"
        onClick={onToggleExpand}
        disabled={!expandable}
        className={cn('flex w-full flex-col gap-1.5 px-3.5 py-2.5 text-left', expandable && 'cursor-pointer')}
      >
        <div className="flex items-center gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-sm bg-accent-soft px-1.5 py-px font-mono text-2xs font-medium text-accent">
            <GitFork size={11} strokeWidth={2} className="rotate-90" />
            subagent
          </span>
          <span className={cn('ml-auto inline-flex flex-none items-center gap-1.5 text-xs', st.cls)}>
            <Icon size={12} strokeWidth={2} className={st.spin ? 'animate-spin' : ''} />
            {statusLabel ?? t(`subagentCard.status.${status}`)}
          </span>
          {expandable ? (
            expanded ? (
              <ChevronDown size={13} className="text-text-tertiary" strokeWidth={2} />
            ) : (
              <ChevronRight size={13} className="text-text-tertiary" strokeWidth={2} />
            )
          ) : null}
        </div>
        <div className="text-base font-medium leading-snug text-text-primary">{title}</div>
        {bottom}
      </button>
      {expanded && children ? (
        <div className="border-t border-border px-3.5 py-2.5 text-xs">{children}</div>
      ) : null}
    </div>
  );
}
