/**
 * 新建 / 编辑定时任务卡：执行内容 + 触发时间清单（计时器/闹钟·可多条）+ 运行位置 + 实时确认语句。
 * 一条任务可挂多条触发时间——保存走 createGroup/updateGroup（组写 diff 在主进程做，前端只传全量 rules）。
 * 「将于…首次触发」确认语句复用主进程（scheduledTask.preview 逐条），前端不重算节奏、只做合并。
 */
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { X } from 'lucide-react';
import type { Conversation, TaskGroup, TaskGroupInput, WhitelistEntry } from '@shared/types';
import { cn } from '@/lib/cn';
import { fetchPreview } from '@/stores/scheduledTaskStore';
import { describeWhen } from '@/lib/scheduledTaskFormat';
import { ConversationSelector } from './ConversationSelector';
import { buildRule, formFromRule } from './specForm';
import { RuleList, newEditRule, type EditRule } from './RuleList';

const inputCls =
  'rounded-md border border-border-strong bg-elevated px-2.5 py-1.5 font-mono text-sm text-text-primary outline-none focus:border-accent-ring';

/** 可推送的认证用户：白名单里已记下聊天地址（chatId）且知道平台的条目——能定位「发到哪个聊天」。 */
type ReachablePerson = WhitelistEntry & { chatId: string; platform: NonNullable<WhitelistEntry['platform']> };

function personLabel(p: ReachablePerson, t: TFunction): string {
  return `${p.displayName ?? p.id} · ${t(`platform.${p.platform}`)}`;
}

export function ComposeModal({
  initial,
  conversations,
  channelPeople,
  onSubmit,
  onClose,
}: {
  initial: TaskGroup | null;
  conversations: Conversation[];
  channelPeople: WhitelistEntry[];
  onSubmit: (input: TaskGroupInput) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation('scheduledTask');
  const [prompt, setPrompt] = useState(initial?.prompt ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  // 编辑：把组内各规则回填成多条 SpecForm（带 taskId 供组写 diff 对齐）；新建：一条默认规则。
  // once 规则按打开时刻换算剩余时长（formFromRule 的 nowMs），故 useState 初始化里取一次 Date.now()。
  const [rules, setRules] = useState<EditRule[]>(() => {
    const nowMs = Date.now();
    return initial ? initial.rules.map((r) => newEditRule(formFromRule(r, nowMs), r.taskId)) : [newEditRule()];
  });
  const [locMode, setLocMode] = useState<'new' | 'pick' | 'channel'>(
    initial?.runLocation.kind === 'conversation'
      ? 'pick'
      : initial?.runLocation.kind === 'channel'
        ? 'channel'
        : 'new',
  );
  const [convId, setConvId] = useState<string | null>(
    initial?.runLocation.kind === 'conversation' ? initial.runLocation.id : conversations[0]?.id ?? null,
  );
  // 渠道落点（G42）：选的是「认证的人」而非对话——每人一个聊天地址（chatId），推送直发该地址。
  const reachablePeople = useMemo(
    () => channelPeople.filter((p): p is ReachablePerson => !!p.chatId && !!p.platform),
    [channelPeople],
  );
  const editChannelChatId = initial?.runLocation.kind === 'channel' ? initial.runLocation.chatId : null;
  const [personId, setPersonId] = useState<string | null>(null);
  useEffect(() => {
    if (locMode !== 'channel') return;
    if (personId && reachablePeople.some((p) => p.id === personId)) return;
    if (editChannelChatId != null) {
      setPersonId(reachablePeople.find((p) => p.chatId === editChannelChatId)?.id ?? null);
      return;
    }
    if (reachablePeople.length === 1) setPersonId(reachablePeople[0].id);
  }, [locMode, reachablePeople, personId, editChannelChatId]);
  const selectedPerson = reachablePeople.find((p) => p.id === personId);
  const targetMissing =
    editChannelChatId != null &&
    reachablePeople.length > 0 &&
    !reachablePeople.some((p) => p.chatId === editChannelChatId);

  // 各规则逐条预览（主进程为准），前端合并成一条确认语句
  const [previews, setPreviews] = useState<{ frequency: string; runs: number[] }[]>([]);
  useEffect(() => {
    let alive = true;
    const specs = rules.map((r) => buildRule(r.form, Date.now()).spec);
    void Promise.all(specs.map((s) => fetchPreview(s))).then((ps) => alive && setPreviews(ps));
    return () => {
      alive = false;
    };
  }, [rules]);

  const allValid = previews.length === rules.length && previews.every((p) => p.runs.length > 0);
  const confirmLine = useMemo(() => {
    const merged = previews.flatMap((p) => p.runs).sort((a, b) => a - b);
    if (!merged.length) return t('compose.confirmIncomplete');
    const first = describeWhen(merged[0]);
    const onlyOnce =
      rules.length === 1 && buildRule(rules[0].form, Date.now()).spec.kind === 'once';
    if (onlyOnce) return t('compose.confirmOnce', { first });
    const frequency = previews.map((p) => p.frequency).filter(Boolean).join(t('common:listSeparator'));
    return t('compose.confirmRecurring', { first, frequency });
  }, [previews, rules, t]);

  // 选了「指定对话」/「推送到渠道」就必须选到具体目标——不静默退化成新建对话
  const locReady =
    locMode === 'new' ||
    (locMode === 'pick' && !!convId) ||
    (locMode === 'channel' && !!selectedPerson);
  const canSave = prompt.trim().length > 0 && rules.length > 0 && allValid && locReady;

  const submit = () => {
    const now = Date.now();
    const input: TaskGroupInput = {
      title: title.trim(),
      prompt: prompt.trim(),
      runLocation:
        locMode === 'channel' && selectedPerson
          ? { kind: 'channel', platform: selectedPerson.platform, chatId: selectedPerson.chatId }
          : locMode === 'pick' && convId
            ? { kind: 'conversation', id: convId }
            : { kind: 'newConversation' },
      // once/「N 分钟后」按提交此刻重算 at——否则会沿用调好表单那一刻的 now，越拖触发越早
      rules: rules.map((r) => {
        const { spec, stopAfterRuns } = buildRule(r.form, now);
        return { taskId: r.taskId, spec, stopAfterRuns };
      }),
    };
    onSubmit(input);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" onMouseDown={onClose}>
      <div
        className="flex max-h-[88vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-border bg-elevated shadow-xl"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <div className="font-serif text-lg">{initial ? t('compose.editTitle') : t('compose.newTitle')}</div>
          <button onClick={onClose} className="text-text-tertiary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <Field label={t('compose.content')}>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={2}
              placeholder={t('compose.contentPlaceholder')}
              className="w-full resize-none rounded-lg border border-border bg-sunken px-3 py-2.5 text-sm leading-relaxed text-text-primary outline-none focus:border-accent-ring"
            />
          </Field>

          <Field label={t('compose.name')}>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('compose.namePlaceholder')}
              className="w-full rounded-md border border-border bg-sunken px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent-ring"
            />
          </Field>

          <Field label={t('compose.triggers')}>
            <RuleList rules={rules} onChange={setRules} />
          </Field>

          <Field label={t('compose.runLocation')}>
            <div className="grid grid-cols-3 gap-2.5">
              <LocCard
                active={locMode === 'new'}
                onClick={() => setLocMode('new')}
                title={t('runLoc.newConversation')}
                desc={t('compose.locNewDesc')}
              />
              <LocCard
                active={locMode === 'pick'}
                onClick={() => setLocMode('pick')}
                title={t('compose.locPick')}
                desc={t('compose.locPickDesc')}
              />
              {/* 渠道落点（G42）：没有可推送的认证用户时禁用并提示——不给假选项 */}
              <LocCard
                active={locMode === 'channel'}
                onClick={() => setLocMode('channel')}
                title={t('compose.locChannel')}
                desc={reachablePeople.length ? t('compose.locChannelDesc') : t('compose.noChannelPeople')}
                disabled={reachablePeople.length === 0}
              />
            </div>
            {/* 极简：只有选「指定对话」/「推送到渠道」才渲染对应选择器 */}
            {locMode === 'pick' ? (
              <div className="mt-2.5">
                <ConversationSelector
                  conversations={conversations}
                  value={convId}
                  onChange={setConvId}
                  disabled={false}
                />
              </div>
            ) : null}
            {/* 渠道落点＝「选认证的人」：0 人报错、1 人自动选中只读展示、多人下拉选人。 */}
            {locMode === 'channel' ? (
              <div className="mt-2.5 space-y-2">
                {reachablePeople.length === 0 ? (
                  <div className="rounded-md border border-warn-ring bg-warn-soft px-3 py-2 text-xs text-warn">
                    {t('compose.noChannelPeople')}
                  </div>
                ) : (
                  <>
                    {targetMissing ? (
                      <div className="rounded-md border border-warn-ring bg-warn-soft px-3 py-2 text-xs text-warn">
                        {t('compose.channelTargetGone')}
                      </div>
                    ) : null}
                    {reachablePeople.length === 1 && !targetMissing ? (
                      <div className="rounded-md border border-border bg-sunken px-3 py-2 text-sm text-text-secondary">
                        {t('compose.channelSingle', { name: personLabel(reachablePeople[0], t) })}
                      </div>
                    ) : (
                      <select
                        value={personId ?? ''}
                        onChange={(e) => setPersonId(e.target.value || null)}
                        className={cn(inputCls, 'w-full')}
                      >
                        <option value="" disabled>
                          {t('compose.channelPickPerson')}
                        </option>
                        {reachablePeople.map((p) => (
                          <option key={p.id} value={p.id}>
                            {personLabel(p, t)}
                          </option>
                        ))}
                      </select>
                    )}
                  </>
                )}
              </div>
            ) : null}
          </Field>

          <div className="mt-5 rounded-lg border border-accent-ring bg-accent-soft px-4 py-3 text-sm leading-relaxed text-text-primary">
            {confirmLine}
          </div>
        </div>

        <div className="flex justify-end gap-2.5 border-t border-border px-5 py-3.5">
          <button
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:bg-hover"
          >
            {t('common:cancel')}
          </button>
          <button
            onClick={submit}
            disabled={!canSave}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg disabled:opacity-40"
          >
            {initial ? t('common:save') : t('compose.create')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mt-5 first:mt-0">
      <div className="mb-2 text-xs font-semibold text-text-secondary">{label}</div>
      {children}
    </div>
  );
}

function LocCard({
  active,
  onClick,
  title,
  desc,
  disabled = false,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex flex-col items-start gap-1 rounded-lg border px-3.5 py-3 text-left transition-colors',
        disabled
          ? 'cursor-not-allowed border-border bg-sunken opacity-50'
          : active
            ? 'border-accent bg-accent-soft'
            : 'border-border bg-sunken hover:border-border-strong',
      )}
    >
      <span className={cn('text-sm font-medium', active ? 'text-accent' : 'text-text-primary')}>{title}</span>
      <span className="text-xs text-text-tertiary">{desc}</span>
    </button>
  );
}
