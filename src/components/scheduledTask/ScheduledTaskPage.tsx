/**
 * 定时任务清单页——和任务版平级的全局清单。错过待处理区在顶部（仅非空时出现），
 * 其下是正常清单（每行：名称/下次触发/频率与运行位置/上次结果 + 开关 + ⋯ 菜单）。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Loader2, MoreHorizontal, Plus, X } from 'lucide-react';
import type { Conversation, TaskGroup, TaskGroupInput, WhitelistEntry } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { describeFrequency } from '@shared/scheduledTasks/describe';
import { isGroupActive, isGroupEnded } from '@shared/scheduledTasks/group';
import { cn } from '@/lib/cn';
import { FloatingLayer } from '@/components/ui/FloatingLayer';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';
import { useConversationStore } from '@/stores/conversationStore';
import { useAgentStore } from '@/stores/agentStore';
import { describeWhen, describeLastRun, describeRunRecord, endedKind } from '@/lib/scheduledTaskFormat';
import { ComposeModal } from './ComposeModal';

const MISSED_PREVIEW = 3;

export default function ScheduledTaskPage({ onOpenChat }: { onOpenChat?: () => void }) {
  const { t } = useTranslation('scheduledTask');
  // 全局同步已提到 App 级（useScheduledTaskSync）——通知中心的「错过」判定常驻依赖它
  const groups = useScheduledTaskStore((s) => s.groups); // 聚合后的用户可见任务（列表主体）
  const inflight = useScheduledTaskStore((s) => s.inflight); // 后台执行中的任务 id（S18·临时态）
  const store = useScheduledTaskStore.getState(); // 方法引用稳定，取所需即可，不订阅整个 store
  const activeAgentId = useAgentStore((s) => s.activeAgentId);
  const conversations = useConversationStore((s) =>
    activeAgentId ? s.byAgent[activeAgentId] ?? [] : [],
  );
  // 运行记录里「查看产出」：打开承载对话（复用跨视图打开范式 setActive + 切回聊天视图）。
  const openRunConversation = (convId: string) => {
    if (activeAgentId) useConversationStore.getState().setActive(activeAgentId, convId);
    onOpenChat?.();
  };

  // 渠道落点「按认证的人选」需要白名单（含各人的聊天地址 chatId）——打开新建/编辑弹窗时按需拉一次。
  const [whitelist, setWhitelist] = useState<WhitelistEntry[]>([]);

  const [filter, setFilter] = useState<'active' | 'ended'>('active');
  const [composing, setComposing] = useState(false);
  const [editing, setEditing] = useState<TaskGroup | null>(null);
  const [showAllMissed, setShowAllMissed] = useState(false);

  useEffect(() => {
    if (!composing) return;
    void wsClient.request({ type: 'platform.getConfig' }).then((r) => {
      if (r.type === 'platform.config') setWhitelist(r.config.whitelist);
    });
  }, [composing]);

  const missed = useMemo(() => groups.filter((g) => g.missedAt != null), [groups]);
  const listed = useMemo(
    () => groups.filter((g) => (filter === 'ended' ? isGroupEnded(g) : isGroupActive(g))),
    [groups, filter],
  );
  // 「已结束」筛选下分两组：已触发（lastRun 非空）/ 未能触发（从没跑成）。进行中筛选不分组，下面不用此值。
  const ended = useMemo(
    () => ({
      triggered: listed.filter((g) => endedKind(g) === 'triggered'),
      notTriggered: listed.filter((g) => endedKind(g) !== 'triggered'),
    }),
    [listed],
  );

  const submit = async (input: TaskGroupInput) => {
    if (editing) await store.updateGroup(editing.groupId, input);
    else await store.createGroup(input);
    setComposing(false);
    setEditing(null);
  };

  const renderRow = (group: TaskGroup) => (
    <TaskRow
      key={group.groupId}
      group={group}
      conversations={conversations}
      inflight={group.rules.some((r) => inflight.includes(r.taskId))}
      onToggle={(en) => void store.setGroupEnabled(group.groupId, en)}
      onRun={() => void store.run(group.rules[0].taskId)}
      onEdit={() => {
        setEditing(group);
        setComposing(true);
      }}
      onDelete={() => void store.deleteGroup(group.groupId)}
      onOpenRun={openRunConversation}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-canvas">
      <div className="mx-auto w-full max-w-3xl p-6">
        <div className="mb-4 flex items-center justify-between">
          <h1 className="font-serif text-2xl">{t('pageTitle')}</h1>
          <button
            onClick={() => {
              setEditing(null);
              setComposing(true);
            }}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg"
          >
            <Plus size={15} /> {t('newTask')}
          </button>
        </div>

        <div className="mb-3 flex items-center gap-2 text-xs text-text-tertiary">
          {t('filterLabel')}
          {(['active', 'ended'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                'rounded-md border px-2 py-0.5',
                filter === f
                  ? 'border-accent-ring bg-accent-soft text-accent'
                  : 'border-border bg-sunken text-text-secondary',
              )}
            >
              {f === 'active' ? t('filter.active') : t('filter.ended')}
            </button>
          ))}
        </div>

        <div className="overflow-hidden rounded-xl border border-border bg-elevated">
          {missed.length > 0 ? (
            <MissedSection
              missed={showAllMissed ? missed : missed.slice(0, MISSED_PREVIEW)}
              total={missed.length}
              showAll={showAllMissed}
              onToggleAll={() => setShowAllMissed((v) => !v)}
              onRun={(groupId) => void store.runGroupMissed(groupId)}
              onDismiss={(groupId) => void store.dismissGroupMissed(groupId)}
            />
          ) : null}

          {listed.length === 0 ? (
            <EmptyState
              ended={filter === 'ended'}
              onCreate={() => {
                setEditing(null);
                setComposing(true);
              }}
              onUseSample={(input) => void store.createGroup(input)}
            />
          ) : filter !== 'ended' ? (
            listed.map(renderRow)
          ) : (
            <>
              {ended.triggered.length > 0 ? (
                <>
                  <GroupHeader label={t('ended.triggered')} />
                  {ended.triggered.map(renderRow)}
                </>
              ) : null}
              {ended.notTriggered.length > 0 ? (
                <>
                  <GroupHeader label={t('ended.notTriggered')} />
                  {ended.notTriggered.map(renderRow)}
                </>
              ) : null}
            </>
          )}
        </div>
      </div>

      {composing ? (
        <ComposeModal
          initial={editing}
          conversations={conversations}
          channelPeople={whitelist}
          onSubmit={(input) => void submit(input)}
          onClose={() => {
            setComposing(false);
            setEditing(null);
          }}
        />
      ) : null}
    </div>
  );
}

function MissedSection({
  missed,
  total,
  showAll,
  onToggleAll,
  onRun,
  onDismiss,
}: {
  missed: TaskGroup[];
  total: number;
  showAll: boolean;
  onToggleAll: () => void;
  onRun: (groupId: string) => void;
  onDismiss: (groupId: string) => void;
}) {
  const { t } = useTranslation('scheduledTask');
  return (
    <div className="border-b border-border bg-warn-soft">
      <div className="px-4 pb-1.5 pt-2.5 text-xs font-semibold text-warn">
        {t('missed.header', { total })}
      </div>
      {missed.map((group) => (
        <div key={group.groupId} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
          <div className="min-w-0">
            <span className="font-medium text-text-primary">{group.title}</span>
            <span className="ml-2 text-xs text-text-secondary">
              {t('missed.original', { when: describeWhen(group.missedAt) })}
            </span>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <button
              onClick={() => onRun(group.groupId)}
              className="rounded-md border border-accent-ring bg-elevated px-3 py-1 text-xs font-medium text-accent"
            >
              {t('missed.run')}
            </button>
            <button
              onClick={() => onDismiss(group.groupId)}
              className="rounded-md border border-border px-2.5 py-1 text-xs text-text-tertiary"
            >
              {t('missed.dismiss')}
            </button>
          </div>
        </div>
      ))}
      {total > MISSED_PREVIEW ? (
        <button onClick={onToggleAll} className="px-4 pb-2.5 pt-1 text-xs font-medium text-warn">
          {showAll ? t('missed.collapse') : t('missed.expandAll', { total })}
        </button>
      ) : null}
    </div>
  );
}

function GroupHeader({ label }: { label: string }) {
  return (
    <div className="border-b border-border bg-sunken px-4 pb-1.5 pt-2 text-xs font-semibold text-text-tertiary">
      {label}
    </div>
  );
}

function TaskRow({
  group,
  conversations,
  inflight,
  onToggle,
  onRun,
  onEdit,
  onDelete,
  onOpenRun,
}: {
  group: TaskGroup;
  conversations: Conversation[];
  inflight?: boolean;
  onToggle: (enabled: boolean) => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onOpenRun: (convId: string) => void;
}) {
  const { t } = useTranslation('scheduledTask');
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const loc = group.runLocation;
  const locText =
    loc.kind === 'newConversation'
      ? t('runLoc.newConversation')
      : loc.kind === 'channel'
        ? t('runLoc.toChannel', { platform: t(`platform.${loc.platform}`) })
        : t('runLoc.inConversation', {
            title: conversations.find((c) => c.id === loc.id)?.title ?? t('runLoc.deletedConv'),
          });

  // 频率：多规则合并成一行（单规则与原来逐像素一致）；分隔符走 i18n（英文界面用 ", "）
  const freqText = group.rules.map((r) => describeFrequency(r.spec, r.stopAfterRuns, t)).join(t('common:listSeparator'));
  // 已结束且从没跑成 → 浅色说明这条没跑成、以及为什么；其余（含已触发、进行中）照旧显示上次结果
  const groupEnded = isGroupEnded(group);
  const ended = groupEnded ? endedKind(group) : null;
  const subline =
    ended === 'dismissed'
      ? t('ended.dismissed')
      : ended === 'expired'
        ? t('ended.expired')
        : describeLastRun(group);

  return (
    <div className="flex items-center gap-3 border-b border-border px-4 py-3.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className={cn('h-1.5 w-1.5 rounded-full', group.enabled ? 'bg-success' : 'bg-text-tertiary')} />
          <span className={cn('text-sm font-semibold', !group.enabled && 'text-text-tertiary')}>
            {group.title}
          </span>
          {group.createdBy === 'agent' ? (
            <span className="rounded bg-accent-soft px-1.5 py-px font-mono text-[10px] text-accent">
              {t('agentBadge')}
            </span>
          ) : null}
          {inflight ? (
            <span className="flex items-center gap-1 rounded bg-accent-soft px-1.5 py-px text-[10px] text-accent">
              <Loader2 size={10} strokeWidth={2} className="animate-spin" />
              {t('status.running')}
            </span>
          ) : null}
        </div>
        <div className="mt-0.5 text-xs text-text-secondary">
          {freqText} · {locText}
        </div>
        <div className="mt-0.5 text-xs text-text-tertiary">{subline}</div>
      </div>

      <div className="flex shrink-0 items-center gap-3">
        <div className="text-right text-xs text-text-secondary">
          {group.enabled && group.nextRunAt != null ? (
            <>
              {t('next')}
              <span className="block text-[13px] font-semibold text-text-primary">
                {describeWhen(group.nextRunAt)}
              </span>
            </>
          ) : (
            <span className="text-text-tertiary">
              {groupEnded ? t('status.ended') : t('status.paused')}
            </span>
          )}
        </div>
        {/* 已结束（全规则无游标）没有下次触发，开关无意义 → 去掉，只留状态字样 + ⋯ 菜单（PRD §4.4） */}
        {!groupEnded ? (
          <button
            onClick={() => onToggle(!group.enabled)}
            className={cn(
              'relative h-5 w-9 rounded-full transition-colors',
              group.enabled ? 'bg-accent' : 'bg-border-strong',
            )}
            aria-label={group.enabled ? t('toggle.pause') : t('toggle.enable')}
          >
            <span
              className={cn(
                'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all',
                group.enabled ? 'left-[18px]' : 'left-0.5',
              )}
            />
          </button>
        ) : null}
        <div>
          <button
            onClick={(e) => {
              // 菜单走 FloatingLayer（fixed + portal），逃出卡片 overflow-hidden——
              // 末行卡片开菜单曾被裁掉下半截
              const r = e.currentTarget.getBoundingClientRect();
              setMenuAt(menuAt ? null : { x: r.right - 112, y: r.bottom + 4 });
            }}
            className="text-text-tertiary hover:text-text-primary"
          >
            <MoreHorizontal size={18} />
          </button>
          {menuAt ? (
            <FloatingLayer x={menuAt.x} y={menuAt.y} onClose={() => setMenuAt(null)} role="menu" className="min-w-28 text-sm">
              <MenuItem label={t('menu.edit')} onClick={() => { setMenuAt(null); onEdit(); }} />
              <MenuItem label={t('menu.runNow')} onClick={() => { setMenuAt(null); onRun(); }} />
              <MenuItem label={t('menu.history')} onClick={() => { setMenuAt(null); setHistoryOpen(true); }} />
              <MenuItem label={t('common:delete')} danger onClick={() => { setMenuAt(null); onDelete(); }} />
            </FloatingLayer>
          ) : null}
        </div>
      </div>
      {historyOpen ? (
        <RunHistoryDialog group={group} onClose={() => setHistoryOpen(false)} onOpenRun={onOpenRun} />
      ) : null}
    </div>
  );
}

/**
 * 运行记录弹窗（G45 可回溯）：历次执行时间 + 结果一行，成功那次可「查看产出」跳到承载对话——
 * 回答「历次结果在哪里」，不必去各触发对话里翻。承载对话已删则灰示不可跳。
 */
function RunHistoryDialog({
  group,
  onClose,
  onOpenRun,
}: {
  group: TaskGroup;
  onClose: () => void;
  onOpenRun: (convId: string) => void;
}) {
  const { t } = useTranslation('scheduledTask');
  const runs = group.runHistory; // 组级合并、已按 at 降序、截上限（groupTasks 构造）
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[70vh] w-[440px] flex-col overflow-hidden rounded-2xl border border-border bg-elevated shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="font-serif text-lg">{t('history.title')}</div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {runs.length === 0 ? (
            <div className="px-3 py-8 text-center text-sm text-text-tertiary">{t('history.empty')}</div>
          ) : (
            runs.map((rec, i) => (
              <div
                key={`${rec.at}-${i}`}
                className="flex items-center gap-3 rounded-md px-3 py-2 text-sm hover:bg-hover"
              >
                <span className="min-w-0 flex-1 text-text-secondary">{describeRunRecord(rec)}</span>
                {rec.conversationId ? (
                  <button
                    onClick={() => onOpenRun(rec.conversationId!)}
                    className="shrink-0 text-xs text-accent hover:underline"
                  >
                    {t('history.viewOutput')}
                  </button>
                ) : (
                  <span className="shrink-0 text-xs text-text-tertiary">{t('history.deletedConv')}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

function MenuItem({ label, onClick, danger }: { label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'block w-full px-3 py-1.5 text-left hover:bg-hover',
        danger ? 'text-danger' : 'text-text-primary',
      )}
    >
      {label}
    </button>
  );
}

// 空清单不是白板：给三个一键可建样例，降低第一次的启动门槛（PRD 体验第一节）。
// 用函数而非常量——「45 分钟后」的绝对时刻须按点击此刻算，不能定格在模块加载时。
// 样例标题/描述/prompt 随界面语言本地化（glossary 边界先例：界面建议→种子内容按语言现造）。
function buildSamples(t: TFunction): { title: string; desc: string; input: TaskGroupInput }[] {
  return [
    {
      title: t('scheduledTask:samples.daily.title'),
      desc: t('scheduledTask:samples.daily.desc'),
      input: {
        title: t('scheduledTask:samples.daily.title'),
        prompt: t('scheduledTask:samples.daily.prompt'),
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'daily', minutesOfDay: 8 * 60 } }],
      },
    },
    {
      title: t('scheduledTask:samples.once.title'),
      desc: t('scheduledTask:samples.once.desc'),
      input: {
        title: t('scheduledTask:samples.once.title'),
        prompt: t('scheduledTask:samples.once.prompt'),
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'once', at: Date.now() + 45 * 60_000 } }],
      },
    },
    {
      title: t('scheduledTask:samples.weekly.title'),
      desc: t('scheduledTask:samples.weekly.desc'),
      input: {
        title: t('scheduledTask:samples.weekly.title'),
        prompt: t('scheduledTask:samples.weekly.prompt'),
        runLocation: { kind: 'newConversation' },
        rules: [{ spec: { kind: 'weekly', weekdays: [5], minutesOfDay: 16 * 60 } }],
      },
    },
  ];
}

function EmptyState({
  onCreate,
  onUseSample,
  ended,
}: {
  onCreate: () => void;
  onUseSample: (input: TaskGroupInput) => void;
  ended: boolean;
}) {
  const { t } = useTranslation('scheduledTask');
  if (ended) {
    return <div className="p-10 text-center text-sm text-text-tertiary">{t('empty.endedNone')}</div>;
  }
  return (
    <div className="flex flex-col items-center gap-4 p-10 text-center">
      <div className="text-sm text-text-secondary">{t('empty.none')}</div>
      <div className="flex flex-wrap justify-center gap-2">
        {buildSamples(t).map((s) => (
          <button
            key={s.title}
            onClick={() => onUseSample(s.input)}
            className="rounded-lg border border-border bg-sunken px-3 py-2 text-left text-sm hover:border-accent-ring"
          >
            <div className="font-medium text-text-primary">{s.title}</div>
            <div className="text-xs text-text-tertiary">{s.desc}</div>
          </button>
        ))}
      </div>
      <button onClick={onCreate} className="text-xs text-text-tertiary underline-offset-2 hover:underline">
        {t('empty.custom')}
      </button>
    </div>
  );
}
