/**
 * Fallback：未单独建子组件的事件类型走这里——格式化 JSON 展示完整 payload
 *
 * 覆盖 prompt_built / llm_call_start / parallel_group_start / parallel_group_done /
 * tool_call_start / round_done 等中间事件。
 */
import { useTranslation } from 'react-i18next';
import type { DebugRecord } from '@shared/debug/types';
import { fmtDuration } from '@/lib/fmtDuration';
import { CopyableBlock } from './CopyableBlock';

export function GenericDetail({ record }: { record: DebugRecord }) {
  const { t } = useTranslation('debug');
  const payloadStr = JSON.stringify(record.payload, null, 2);
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('detail.type')} value={record.type} mono />
        <Field label={t('detail.seq')} value={`#${record.seq}`} />
        <Field label={t('detail.relTime')} value={`+${fmtDuration(record.relMs)}`} />
        <Field label={t('detail.absTime')} value={new Date(record.ts).toLocaleString()} />
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{t('detail.fullPayload')}</div>
        <CopyableBlock
          copyText={payloadStr}
          className="whitespace-pre-wrap break-all rounded-md bg-canvas p-2 text-xs text-text-secondary"
        >
          {payloadStr}
        </CopyableBlock>
      </div>
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
