/**
 * prompt_built 详情——只展示 systemContext + 元数据。
 *
 * v0.5：原 raw history 字段已从 schema 砍掉——真实入参（adapter 之后）由 inference_view
 * 事件的 wireHistory 承载。本组件不再渲染 history，避免误导用户以为这是模型实际看到的内容。
 */
import { useTranslation } from 'react-i18next';
import type { DebugRecord } from '@shared/debug/types';
import { fmtDuration } from '@/lib/fmtDuration';
import { CopyableBlock } from './CopyableBlock';

export function PromptBuiltDetail({ record }: { record: DebugRecord<'prompt_built'> }) {
  const { t } = useTranslation('debug');
  const p = record.payload;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('detail.systemContextChars')} value={p.systemContextChars.toLocaleString()} />
        <Field label={t('detail.stableSystemChars')} value={p.stableSystemContextChars.toLocaleString()} />
        <Field label={t('detail.duration')} value={fmtDuration(p.durationMs)} />
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">
          {t('detail.systemContextFull')}
        </div>
        <CopyableBlock
          copyText={p.systemContext}
          className="whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-text-primary"
        >
          {p.systemContext}
        </CopyableBlock>
      </div>
      <div className="rounded-md border border-border bg-canvas/50 p-2 text-xs text-text-tertiary">
        {t('detail.promptNote')}
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="text-text-primary">{value}</div>
    </div>
  );
}
