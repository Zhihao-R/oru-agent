/**
 * 最终回答详情——分身给用户看到的完整文字 + 整轮汇总
 */
import { useTranslation } from 'react-i18next';
import type { DebugRecord } from '@shared/debug/types';
import { fmtDuration } from '@/lib/fmtDuration';
import { CopyableBlock } from './CopyableBlock';

export function FinalAnswerDetail({ record }: { record: DebugRecord<'final_answer'> }) {
  const { t } = useTranslation('debug');
  const p = record.payload;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('detail.totalDuration')} value={fmtDuration(p.totalDurationMs)} />
        <Field label={t('detail.finalModel')} value={p.finalModel ?? <span className="text-text-tertiary">—</span>} />
        <Field label={t('detail.totalInput')} value={p.totalInputTokens.toLocaleString()} />
        <Field label={t('detail.totalOutput')} value={p.totalOutputTokens.toLocaleString()} />
        {p.aborted ? <Field label={t('detail.status')} value={<span className="text-warn">{t('detail.userAborted')}</span>} /> : null}
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{t('detail.finalOutput')}</div>
        {p.text ? (
          <CopyableBlock
            copyText={p.text}
            className="whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-text-primary"
          >
            {p.text}
          </CopyableBlock>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-text-primary">
            <span className="text-text-tertiary">{t('detail.noTextOutput')}</span>
          </pre>
        )}
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
