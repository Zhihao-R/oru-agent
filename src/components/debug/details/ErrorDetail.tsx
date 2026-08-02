/**
 * 错误事件详情
 */
import { useTranslation } from 'react-i18next';
import type { DebugRecord } from '@shared/debug/types';
import { CopyableBlock } from './CopyableBlock';

export function ErrorDetail({ record }: { record: DebugRecord<'error'> }) {
  const { t } = useTranslation('debug');
  const p = record.payload;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('detail.phase')} value={p.phase} />
        {p.code ? <Field label={t('detail.errorCode')} value={p.code} mono /> : null}
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{t('detail.errorInfo')}</div>
        <CopyableBlock
          copyText={p.message}
          className="whitespace-pre-wrap break-words rounded-md bg-danger-soft p-2 text-danger"
        >
          {p.message}
        </CopyableBlock>
      </div>
      {p.stack ? (
        <div>
          <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{t('detail.stack')}</div>
          <CopyableBlock
            copyText={p.stack}
            className="whitespace-pre-wrap break-all rounded-md bg-canvas p-2 text-xs text-text-secondary"
          >
            {p.stack}
          </CopyableBlock>
        </div>
      ) : null}
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
