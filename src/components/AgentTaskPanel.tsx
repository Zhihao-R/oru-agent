/**
 * 通知中心（原「任务记录」弹层，2026-06-23 升级）。
 *
 * 你走开回来一眼看清 Oru 都干了什么——汇集当前分身**正在跑 / 已结束**的对话，按"要不要你管"
 * 分三段：需要你处理（置顶）→ 已完成（待验收，看过即清）→ 进行中。
 *
 * 单一状态来源：每条对话过 `conversationStatus` 的 deriveConvBadge/State 判定（与对话列表四态标记
 * 同一处），三段 ⟺ badge 三值（todo / unread / running），none 即不进通知中心。
 *
 * 复用、不新造交互（承重约束）：
 * - 等你审批 = <ProposalCard>（按 kind 自动分发，自带 accept/reject + lifecycle）——必须复用，
 *   重写会绕过 transitionProposal（约束 2/3）。
 * - 等你回答：追问槽（TaskQuestionBubble）已随委派收敛退役（P3：用户不直接对 subagent 插嘴，
 *   追问走 ask_twin 问主 agent）——本处只做「跳对话」导航，不内嵌回答输入。
 * - 进行中 / 已完成 / 出错只是展示行 + 既有 RPC（停止 / 打开 / 重试 / 忽略），用对话级轻行呈现。
 * 「忽略」只前端隐藏（notificationStore.dismiss），绝不碰后端 proposal（约束 2）。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ActionProposal, ChatMessage, SubagentTask } from '@shared/types';
import type { SystemSignal } from '@shared/protocol';
import { wsClient } from '@/lib/ws';
import { cn } from '@/lib/cn';
import { useAgentStore } from '@/stores/agentStore';
import { useChatStore } from '@/stores/chatStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useTaskStore } from '@/stores/taskStore';
import { useNotificationStore } from '@/stores/notificationStore';
import { useSystemSignalStore } from '@/stores/systemSignalStore';
import { groupTasksByConv } from '@/lib/conversationStatus';
import { useNotificationItems, type NotifItem } from '@/lib/useNotifications';

type Props = {
  onClose: () => void;
  /** 切到对话页——通知项点击 / 重试要把可见页面拨回 chat（面板挂在 TopBar，可能停在非 chat 页，
   *  只 setActive 改不了当前页，见 App.tsx 的 page state）。 */
  onGoChat?: () => void;
};

/** 子任务是否还在跑（含排队 / 等 twin 加工——都不需要你管） */
function isRunningTask(t: SubagentTask): boolean {
  return t.status === 'running' || t.status === 'pending' || t.status === 'awaiting_twin';
}

export function AgentTaskPanel({ onClose, onGoChat }: Props) {
  const { t } = useTranslation('notification');
  const agentId = useAgentStore((s) => s.activeAgentId);
  const setActive = useConversationStore((s) => s.setActive);
  const retryLast = useChatStore((s) => s.retryLast);
  const tasks = useTaskStore((s) => s.tasks);
  const proposalsByConv = useTaskStore((s) => s.proposalsByConv);
  const messagesByConv = useChatStore((s) => s.conversations);
  const convsLen = useConversationStore((s) => (agentId ? s.byAgent[agentId]?.length ?? 0 : 0));

  const tasksByConv = useMemo(() => groupTasksByConv(tasks), [tasks]);
  const { needAction, done, running } = useNotificationItems(agentId);
  // 系统信号（S14）：不归任何对话，单列一段置顶，不与对话混排
  const systemSignals = useSystemSignalStore((s) => s.signals);

  const open = (convId: string) => {
    if (agentId) setActive(agentId, convId);
    onGoChat?.();
    onClose();
  };

  const isEmpty =
    systemSignals.length === 0 && needAction.length === 0 && done.length === 0 && running.length === 0;

  return (
    // 无「通知」标题头（设计稿 4a 直接分区起）；分组 + 底部角标口径，导航式一行条目
    <div className="flex max-h-[440px] flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto pt-1">
        {isEmpty ? (
          <EmptyState hasConvs={convsLen > 0} />
        ) : (
          <>
            {systemSignals.length > 0 ? (
              // 系统组保留置顶（PM 拍板），但标题用中性灰——warn 琥珀只留给「需要你处理」（设计稿）
              <Section label={t('system')} count={systemSignals.length} tone="muted">
                {systemSignals.map((sig) => (
                  <SystemSignalRow key={sig.id} signal={sig} />
                ))}
              </Section>
            ) : null}

            {needAction.length > 0 ? (
              <Section label={t('needAction')} count={needAction.length} tone="warn">
                {needAction.map((it) => (
                  <NeedActionItem
                    key={it.conv.id}
                    item={it}
                    tasksByConv={tasksByConv}
                    proposalsByConv={proposalsByConv}
                    messagesByConv={messagesByConv}
                    onOpen={() => open(it.conv.id)}
                    onRetry={() => {
                      if (agentId) setActive(agentId, it.conv.id);
                      void retryLast(it.conv.id);
                      onGoChat?.();
                      onClose();
                    }}
                  />
                ))}
              </Section>
            ) : null}

            {done.length > 0 ? (
              <Section label={t('done')} count={done.length} tone="muted">
                <DoneList items={done} tasksByConv={tasksByConv} onOpen={open} />
              </Section>
            ) : null}

            {running.length > 0 ? (
              <Section label={t('running')} count={running.length} tone="muted">
                {running.map((it) => (
                  <RunningItem
                    key={it.conv.id}
                    item={it}
                    tasksByConv={tasksByConv}
                    onOpen={() => open(it.conv.id)}
                  />
                ))}
              </Section>
            ) : null}
          </>
        )}
      </div>

      {/* 底部角标口径说明（设计稿 4a）：这枚角标 = 需处理 + 系统，单一口径 */}
      {!isEmpty && needAction.length + systemSignals.length > 0 ? (
        <div className="border-t border-border bg-sunken-2 px-4 py-2 text-2xs text-text-quaternary">
          {t('badgeExplain', {
            total: needAction.length + systemSignals.length,
            need: needAction.length,
            sys: systemSignals.length,
          })}
        </div>
      ) : null}
    </div>
  );
}

/** 分区：标题「标签 · N」+ 组间以顶边分隔（设计稿 4a）——warn 段用琥珀中等字重，其余中性灰 */
function Section({
  label,
  count,
  tone,
  children,
}: {
  label: string;
  count: number;
  tone: 'warn' | 'muted';
  children: React.ReactNode;
}) {
  return (
    <div className="border-t border-border first:border-t-0">
      <div
        className={cn(
          'px-4 pb-1.5 pt-2.5 text-xs tracking-wider',
          tone === 'warn' ? 'font-medium text-warn' : 'text-text-quaternary',
        )}
      >
        {label} · {count}
      </div>
      <div className="flex flex-col pb-1.5">{children}</div>
    </div>
  );
}

/** 行壳：状态点 + 标题/简述 + 右侧动作；整行点击=打开对话，动作按钮 stopPropagation（设计稿 4a：垂直居中 · 整行 hover 浅底） */
function Row({
  icon,
  title,
  subtext,
  subtone,
  onOpen,
  actions,
}: {
  icon: React.ReactNode;
  title: string;
  subtext?: string;
  subtone?: 'danger' | 'muted';
  onOpen: () => void;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-[9px] px-4 py-2 transition-colors hover:bg-sunken-2">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-[9px] text-left">
        <span className="shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-text-primary">{title}</span>
          {subtext ? (
            <span
              className={cn(
                'mt-0.5 block truncate text-xs',
                subtone === 'danger' ? 'text-danger' : 'text-text-tertiary',
              )}
            >
              {subtext}
            </span>
          ) : null}
        </span>
      </button>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
  );
}

/** 小动作按钮（停止 / 重试 / 忽略 / 现在执行）——accent 软填充胶囊（设计稿 4a 动作按钮样式） */
function MiniButton({
  onClick,
  children,
  title,
}: {
  onClick: () => void;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className="inline-flex shrink-0 items-center rounded bg-accent-soft px-2.5 py-[3px] text-xs text-accent-deep hover:bg-accent-line"
    >
      {children}
    </button>
  );
}

/** "另外还有 N 个子任务在跑"——多状态并存时不丢"它其实还在动"（PRD） */
function RunningFootnote({ count }: { count: number }) {
  const { t } = useTranslation('notification');
  if (count <= 0) return null;
  return (
    <div className="-mt-1 px-4 pb-2 pl-[33px] text-xs text-text-tertiary">
      {t('runningFootnote', { count })}
    </div>
  );
}

/**
 * 行首状态点——通知中心统一的状态字形（设计稿 4a：全用小圆点，不用图标）：
 * - wait/error：8px + 3px 淡晕圈（琥珀=等你 / 红=出错），独占最高视觉强度；
 * - running：8px accent 呼吸点（降半层）；done：6px accent 静点；system：6px 中性灰点。
 */
function StatusDot({ variant }: { variant: 'wait' | 'error' | 'running' | 'done' | 'system' }) {
  switch (variant) {
    // 晕圈用 color-mix 取自身色的 22% 淡色（对齐设计稿可见的琥珀晕圈 #f3e8cf，且随主题联动）——
    // 不用 --warn-soft/--danger-soft：那是近白的填充底色，做晕圈几乎不可见，会吞掉「等你处理」的最高视觉强度。
    case 'wait':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-warn shadow-[0_0_0_3px_color-mix(in_srgb,var(--warn)_22%,transparent)]" />;
    case 'error':
      return <span className="h-2 w-2 shrink-0 rounded-full bg-danger shadow-[0_0_0_3px_color-mix(in_srgb,var(--danger)_22%,transparent)]" />;
    case 'running':
      return <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-accent" />;
    case 'done':
      return <span className="mx-px h-1.5 w-1.5 shrink-0 rounded-full bg-accent opacity-80" />;
    case 'system':
      return <span className="mx-px h-1.5 w-1.5 shrink-0 rounded-full bg-text-quaternary" />;
  }
}

/**
 * 「需要你处理」一条对话：一行导航式（设计稿 4a）——黄点 + 待处理标题 + 对话名·状态 + 回复/查看按钮。
 * 点条目或按钮跳到对话，**实际审批/回答在对话输入区的停靠面板处理**（话-1 架构）——本处只做导航，
 * 不内嵌 ProposalCard，故不绕过 transitionProposal（约束仍守）。报错/错过定时另有重试/忽略。
 */
function NeedActionItem({
  item,
  tasksByConv,
  proposalsByConv,
  messagesByConv,
  onOpen,
  onRetry,
}: {
  item: NotifItem;
  tasksByConv: Record<string, SubagentTask[]>;
  proposalsByConv: Record<string, ActionProposal[]>;
  messagesByConv: Record<string, ChatMessage[]>;
  onOpen: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation('notification');
  const dismiss = useNotificationStore((s) => s.dismiss);
  const questionsByTask = useTaskStore((s) => s.questionsByTask);
  const convTasks = tasksByConv[item.conv.id] ?? [];
  const runningCount = convTasks.filter(isRunningTask).length;

  // code 派工排队保持 pending 却恒自动执行，不把「排队后台派工」当待办（showError/showMissed 归一）
  const pending = (proposalsByConv[item.conv.id] ?? []).filter(
    (p) => p.status === 'pending' && p.kind !== 'code',
  );
  const awaitingTask = convTasks.find((task) => task.status === 'awaiting_user');
  const lastQuestion = awaitingTask ? (questionsByTask[awaitingTask.id] ?? []).at(-1) : undefined;
  const showError =
    pending.length === 0 && !awaitingTask && (item.state === 'errored' || convTasks.some((task) => task.status === 'failed'));
  const showMissed = pending.length === 0 && !awaitingTask && !showError && item.state === 'missed';

  // 追问：点「回复」跳对话作答
  if (awaitingTask && lastQuestion) {
    return (
      <div>
        <Row
          icon={<StatusDot variant="wait" />}
          title={lastQuestion.question}
          subtext={`${item.conv.title} · ${t('awaitingReply')}`}
          onOpen={onOpen}
          actions={<MiniButton onClick={onOpen}>{t('reply')}</MiniButton>}
        />
        <RunningFootnote count={runningCount} />
      </div>
    );
  }
  // 待审批：点「查看」跳对话，在输入区停靠面板批/拒
  if (pending.length > 0) {
    return (
      <div>
        <Row
          icon={<StatusDot variant="wait" />}
          title={pending[0].title}
          subtext={`${item.conv.title} · ${t('awaitingConfirm')}`}
          onOpen={onOpen}
          actions={<MiniButton onClick={onOpen}>{t('view')}</MiniButton>}
        />
        <RunningFootnote count={runningCount} />
      </div>
    );
  }

  return (
    <div>
      {showError ? (
        <Row
          icon={<StatusDot variant="error" />}
          title={item.conv.title}
          subtext={convErrorMessage(convTasks, messagesByConv[item.conv.id] ?? [], t)}
          subtone="danger"
          onOpen={onOpen}
          actions={
            <>
              <MiniButton onClick={onRetry}>{t('retry')}</MiniButton>
              <MiniButton onClick={() => dismiss(item.conv.id)}>{t('ignore')}</MiniButton>
            </>
          }
        />
      ) : null}

      {showMissed ? (
        <Row
          icon={<StatusDot variant="wait" />}
          title={item.conv.title}
          subtext={t('missedScheduled')}
          onOpen={onOpen}
          actions={<MiniButton onClick={() => dismiss(item.conv.id)}>{t('ignore')}</MiniButton>}
        />
      ) : null}

      <RunningFootnote count={runningCount} />
    </div>
  );
}

/** 报错简述归一：failed task 的 errorMessage ＞ 末条消息的 error.message ＞ 兜底（§3 三来源归一） */
function convErrorMessage(convTasks: SubagentTask[], messages: ChatMessage[], t: TFunction): string {
  const failed = convTasks.find((task) => task.status === 'failed');
  if (failed?.errorMessage) return failed.errorMessage;
  return messages.at(-1)?.error?.message ?? t('interrupted');
}

/**
 * 已完成段：待验收收件箱，默认摊开最近 10 条，余下收在「查看更多」后；可忽略（2026-07-10 拍板）。
 * 忽略落已持久化的已读水位（markSeen）而非会话级 dismissedAt——待验收是终态、不会被后续动静
 * 自然冲掉，若只做前端隐藏，重启后被忽略的条目会全量复活；「看过即消」与「忽略」在 done 上
 * 本就是同一水位语义。
 */
function DoneList({
  items,
  tasksByConv,
  onOpen,
}: {
  items: NotifItem[];
  tasksByConv: Record<string, SubagentTask[]>;
  onOpen: (convId: string) => void;
}) {
  const { t } = useTranslation('notification');
  const markSeen = useConversationStore((s) => s.markSeen);
  const VISIBLE = 10;
  const shown = items.slice(0, VISIBLE);
  const moreCount = items.length - shown.length;
  return (
    <>
      {shown.map((it) => {
        const lastDone = (tasksByConv[it.conv.id] ?? [])
          .filter((task) => task.status === 'done' && task.summary)
          .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0];
        return (
          <Row
            key={it.conv.id}
            icon={<StatusDot variant="done" />}
            title={it.conv.title}
            // 「待验收」下放到副文本（设计稿：摘要 · 待验收）——段标题缩为「完成」后，别丢掉「这些还等你验收」的语义
            subtext={lastDone?.summary ? `${lastDone.summary} · ${t('pendingReview')}` : t('pendingReview')}
            subtone="muted"
            onOpen={() => onOpen(it.conv.id)}
            actions={
              <MiniButton onClick={() => markSeen(it.conv.agentId, it.conv.id)}>
                {t('ignore')}
              </MiniButton>
            }
          />
        );
      })}
      {moreCount > 0 ? (
        <div className="px-4 pb-1 pl-[33px] text-xs text-text-tertiary">{t('moreDone', { count: moreCount })}</div>
      ) : null}
    </>
  );
}

function RunningItem({
  item,
  tasksByConv,
  onOpen,
}: {
  item: NotifItem;
  tasksByConv: Record<string, SubagentTask[]>;
  onOpen: () => void;
}) {
  const { t } = useTranslation('notification');
  const progressByTask = useTaskStore((s) => s.progressByTask);
  const runningTask = (tasksByConv[item.conv.id] ?? []).find(isRunningTask);
  // 有子任务用其进度文案（缺省「运行中…」）；纯主 agent 流式则是「Oru 正在回复…」
  const fallback = runningTask ? t('taskRunning') : t('oruReplying');
  const subtext = (runningTask ? progressByTask[runningTask.id]?.text : undefined) ?? fallback;

  const stop = () => {
    if (runningTask) {
      void wsClient.request({ type: 'task.cancel', taskId: runningTask.id }).catch(() => undefined);
    } else {
      void useChatStore.getState().abort(item.conv.id);
    }
  };

  return (
    <Row
      icon={<StatusDot variant="running" />}
      title={item.conv.title}
      subtext={subtext}
      subtone="muted"
      onOpen={onOpen}
      actions={<MiniButton onClick={stop}>{t('stop')}</MiniButton>}
    />
  );
}

/**
 * 系统信号一行（S14 · G106/G127）——不归任何对话：图标按严重度着色，标题按 kind + params 译，
 * detail 是原始诊断（含 jargon，不翻）。可忽略（本地隐藏，不删底层问题；自愈后再发是新事件）。
 */
function SystemSignalRow({ signal }: { signal: SystemSignal }) {
  const { t } = useTranslation('notification');
  const dismiss = useSystemSignalStore((s) => s.dismiss);
  const critical = signal.severity === 'critical';
  const params: Record<string, string | number> = { ...signal.params };
  if (typeof params.platform === 'string') {
    params.platform = t(`systemSignal.platformName.${params.platform}`, { defaultValue: params.platform });
  }
  return (
    <div className="flex items-center gap-[9px] px-4 py-2 transition-colors hover:bg-sunken-2">
      <StatusDot variant={critical ? 'error' : 'system'} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-text-primary">{t(`systemSignal.${signal.kind}`, params)}</span>
        {signal.detail ? (
          <span className="mt-0.5 block truncate text-xs text-text-tertiary" title={signal.detail}>
            {signal.detail}
          </span>
        ) : null}
      </span>
      <MiniButton onClick={() => void dismiss(signal.id)}>{t('ignore')}</MiniButton>
    </div>
  );
}

function EmptyState({ hasConvs }: { hasConvs: boolean }) {
  const { t } = useTranslation('notification');
  return (
    <div className="px-3 py-6 text-center text-xs leading-relaxed text-text-tertiary">
      {hasConvs ? t('allClear') : t('emptyNoTasks')}
    </div>
  );
}
