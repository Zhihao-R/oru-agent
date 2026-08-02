/**
 * 中栏：纵向时间线——按 timeline.nodes 顺序渲染 EventRow / ParallelGroup
 */
import { useTranslation } from 'react-i18next';
import type { TimelineModel } from '@/lib/buildTimelineModel';
import type { SelectedEvent } from '@/stores/debugStore';
import { EventRow } from './EventRow';
import { ParallelGroup } from './ParallelGroup';
import { TIMELINE_COLS } from './timelineLayout';

export function Timeline({
  model,
  selectedEventId,
  onSelectEvent,
}: {
  model: TimelineModel;
  selectedEventId: string | null;
  onSelectEvent: (e: SelectedEvent | null) => void;
}) {
  const { t } = useTranslation('debug');
  return (
    <div className="flex-1 overflow-y-auto">
      {/* 列表头：列结构由 TIMELINE_COLS 单源给出 */}
      <div className={`sticky top-0 z-10 grid ${TIMELINE_COLS} items-center gap-3 border-b border-border bg-elevated/95 px-3 py-2 text-[10px] uppercase tracking-wider text-text-tertiary backdrop-blur`}>
        <span />
        <span>{t('timeline.colEvent')}</span>
        <span>{t('timeline.colDuration')}</span>
        <span>{t('timeline.colToken')}</span>
        <span>{t('timeline.colModelStatus')}</span>
      </div>
      {model.nodes.length === 0 ? (
        <div className="p-6 text-center text-sm text-text-tertiary">{t('timeline.empty')}</div>
      ) : (
        model.nodes.map((node) =>
          node.kind === 'group' ? (
            <ParallelGroup
              key={node.id}
              group={node}
              selectedEventId={selectedEventId}
              onSelectEvent={onSelectEvent}
            />
          ) : (
            <EventRow
              key={node.id}
              event={node}
              selected={selectedEventId === node.id}
              onClick={() =>
                onSelectEvent({ id: node.id, record: node.record, toolMeta: node.toolMeta })
              }
            />
          ),
        )
      )}
    </div>
  );
}
