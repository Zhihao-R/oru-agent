/**
 * 定时任务「在指定对话中运行」的对话选择器。
 *
 * 承重约束：分组与图标逻辑与对话列表共用一份（groupConversations + ConversationIcon），
 * 不另写一套。picker 特有的只是展示层——搜索栏、单选、默认仅展开「今天」、命中分组自动展开。
 */
import { useMemo, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { Conversation } from '@shared/types';
import { cn } from '@/lib/cn';
import { ConversationIcon } from '@/components/ConversationIcon';
import { bucketLabel, type ConversationBucket } from '@/lib/conversationBuckets';
import { groupConversations } from '@/lib/conversationGrouping';

type GroupKey = ConversationBucket | 'archived';
const GROUP_ORDER: GroupKey[] = ['today', 'week', 'earlier', 'archived'];

export function ConversationSelector({
  conversations,
  value,
  onChange,
  disabled = false,
}: {
  conversations: Conversation[];
  value: string | null;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation('scheduledTask');
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  // 默认仅展开「今天」，其余收起（与 PRD 一致）
  const [collapsed, setCollapsed] = useState<Record<GroupKey, boolean>>({
    today: false,
    week: true,
    earlier: true,
    archived: true,
  });
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const groups = useMemo(() => groupConversations(conversations), [conversations]);
  const selected = conversations.find((c) => c.id === value) ?? null;
  const searching = q.trim().length > 0;
  const ql = q.trim().toLowerCase();

  const visible = (k: GroupKey): Conversation[] => {
    const list = groups[k];
    return searching ? list.filter((c) => c.title.toLowerCase().includes(ql)) : list;
  };

  return (
    <div
      ref={rootRef}
      className={cn('relative w-64', disabled && 'pointer-events-none opacity-40')}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-md border border-border-strong bg-elevated px-2.5 py-1.5 text-left text-sm text-text-primary"
      >
        {selected ? (
          <ConversationIcon conv={selected} />
        ) : (
          <span className="text-text-tertiary">{t('picker.select')}</span>
        )}
        <span className="min-w-0 flex-1 truncate">{selected?.title}</span>
        <ChevronDown
          size={13}
          className={cn('shrink-0 text-text-tertiary transition-transform', open && 'rotate-180')}
        />
      </button>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+6px)] z-20 overflow-hidden rounded-xl border border-border bg-elevated shadow-lg">
          <div className="border-b border-border p-2">
            <div className="flex items-center gap-1.5 rounded-md border border-border bg-sunken px-2 py-1">
              <Search size={12} className="text-text-tertiary" />
              <input
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('picker.search')}
                className="w-full bg-transparent text-xs text-text-primary outline-none"
              />
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto p-1">
            {GROUP_ORDER.every((k) => visible(k).length === 0) ? (
              <div className="p-4 text-center text-xs text-text-tertiary">{t('picker.noMatch')}</div>
            ) : (
              GROUP_ORDER.map((k) => {
                const items = visible(k);
                if (items.length === 0) return null;
                const isCollapsed = searching ? false : collapsed[k];
                return (
                  <div key={k}>
                    <button
                      type="button"
                      onClick={() =>
                        !searching && setCollapsed((c) => ({ ...c, [k]: !c[k] }))
                      }
                      className="flex w-full items-center gap-1 px-2 py-1.5 font-mono text-[10px] uppercase tracking-wide text-text-tertiary"
                    >
                      <ChevronRight
                        size={11}
                        className={cn('transition-transform', !isCollapsed && 'rotate-90')}
                      />
                      {bucketLabel(k, t)} · {items.length}
                    </button>
                    {!isCollapsed
                      ? items.map((c) => (
                          <button
                            key={c.id}
                            type="button"
                            onClick={() => {
                              onChange(c.id);
                              setOpen(false);
                            }}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-2 py-1.5 pl-6 text-left text-sm transition-colors',
                              c.id === value
                                ? 'bg-accent-soft text-text-primary'
                                : 'text-text-secondary hover:bg-hover',
                            )}
                          >
                            <ConversationIcon conv={c} />
                            <span className="min-w-0 truncate">{c.title}</span>
                          </button>
                        ))
                      : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
