/**
 * 并发组——折叠头 + 缩进容器
 *
 * 列结构跟 EventRow 同步：去掉相对时间列；耗时全用秒。
 *
 *   ‖ 并发组（3 个）  共 0.12s
 *     ├─ 🔧 read_file       0.08s
 *     ├─ 🔧 grep            0.12s
 *     └─ 🔧 list_directory  0.04s
 */
import { useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { TimelineGroup } from '@/lib/buildTimelineModel';
import type { SelectedEvent } from '@/stores/debugStore';
import { fmtDuration } from '@/lib/fmtDuration';
import { EventRow } from './EventRow';
import { TIMELINE_COLS } from './timelineLayout';

export function ParallelGroup({
  group,
  selectedEventId,
  onSelectEvent,
}: {
  group: TimelineGroup;
  selectedEventId: string | null;
  onSelectEvent: (e: SelectedEvent | null) => void;
}) {
  const { t } = useTranslation('debug');
  const [expanded, setExpanded] = useState(true);
  const count = group.children.length;
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`grid w-full cursor-pointer ${TIMELINE_COLS} items-center gap-3 px-3 py-1.5 text-left text-sm transition-colors hover:bg-hover`}
      >
        <span className="flex items-center justify-center">
          {expanded ? (
            <ChevronDown size={14} strokeWidth={1.5} className="text-text-tertiary" />
          ) : (
            <ChevronRight size={14} strokeWidth={1.5} className="text-text-tertiary" />
          )}
        </span>
        <span className="text-text-primary">
          ‖{' '}
          <Trans
            t={t}
            i18nKey="group.label"
            values={{ count }}
            components={{ b: <span className="font-medium" /> }}
          />
        </span>
        <span className="font-mono text-xs text-text-secondary tabular-nums">
          {group.longestDurationMs !== undefined
            ? t('group.total', { dur: fmtDuration(group.longestDurationMs) })
            : t('group.running')}
        </span>
        <span />
        <span className="text-xs text-text-tertiary">{t('group.fromLlmCall', { n: group.llmCallIndex })}</span>
      </button>
      {expanded
        ? group.children.map((child) => (
            <EventRow
              key={child.id}
              event={child}
              indented
              selected={selectedEventId === child.id}
              onClick={() =>
                onSelectEvent({ id: child.id, record: child.record, toolMeta: child.toolMeta })
              }
            />
          ))
        : null}
    </div>
  );
}
