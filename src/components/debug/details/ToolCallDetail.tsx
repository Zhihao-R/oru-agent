/**
 * 工具调用详情——input / output / 错误标记
 *
 * tool_call_done payload 不含 input/name（这俩字段在 tool_call_start 上）；
 * buildTimelineModel 把它们扁平化为 ToolMeta（{ name, input }），通过 SelectedEvent.toolMeta 透传过来。
 */
import { useTranslation } from 'react-i18next';
import type { DebugRecord } from '@shared/debug/types';
import type { ToolMeta } from '@/lib/buildTimelineModel';
import { fmtDuration } from '@/lib/fmtDuration';
import { CopyableBlock } from './CopyableBlock';

export function ToolCallDetail({
  record,
  toolMeta,
}: {
  record: DebugRecord<'tool_call_done'>;
  toolMeta?: ToolMeta;
}) {
  const { t } = useTranslation('debug');
  const p = record.payload;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        {toolMeta ? <Field label={t('detail.toolName')} value={toolMeta.name} /> : null}
        <Field label={t('detail.toolCallId')} value={p.toolCallId} mono />
        <Field label={t('detail.duration')} value={fmtDuration(p.durationMs)} />
        {p.parallelGroupId ? <Field label={t('detail.parallelGroup')} value={p.parallelGroupId} mono /> : null}
        {p.isError ? <Field label={t('detail.status')} value={<span className="text-danger">{t('row.failed')}</span>} /> : null}
      </div>
      {toolMeta ? <Section label={t('detail.inputParams')} value={<JsonBlock value={toolMeta.input} />} /> : null}
      <Section label={t('detail.output')} value={<JsonBlock value={p.output} />} />
      {p.structured ? <Section label={t('detail.structuredMeta')} value={<JsonBlock value={p.structured} />} /> : null}
    </div>
  );
}

/** 工具未完成（卡死/crash）时的兜底渲染——只有 start 没 done */
export function ToolCallUnfinishedDetail({ record }: { record: DebugRecord<'tool_call_start'> }) {
  const { t } = useTranslation('debug');
  const p = record.payload;
  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-md border border-warn bg-warn-soft p-2 text-xs text-warn">
        {t('detail.toolUnfinished')}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('detail.toolCallId')} value={p.toolCallId} mono />
        <Field label={t('detail.toolName')} value={p.name} />
      </div>
      <Section label={t('detail.inputParams')} value={<JsonBlock value={p.input} />} />
    </div>
  );
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className={`text-text-primary ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  );
}

function Section({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{label}</div>
      <div>{value}</div>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  let str: string;
  try {
    str = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  } catch {
    str = String(value);
  }
  return (
    <CopyableBlock
      copyText={str}
      className="whitespace-pre-wrap break-all rounded-md bg-canvas p-2 text-xs text-text-secondary"
    >
      {str}
    </CopyableBlock>
  );
}
