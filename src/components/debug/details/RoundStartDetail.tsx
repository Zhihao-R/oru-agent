/**
 * 用户输入详情（PRD 第四节"用户输入详情"）
 */
import { useTranslation } from 'react-i18next';
import type { DebugRecord } from '@shared/debug/types';
import { CopyableBlock } from './CopyableBlock';

export function RoundStartDetail({ record }: { record: DebugRecord<'round_start'> }) {
  const { t } = useTranslation('debug');
  const p = record.payload;
  const ts = new Date(record.ts).toLocaleString();
  return (
    <div className="space-y-3 text-sm">
      <Section label={t('detail.time')} value={ts} />
      <Section label={t('detail.source')} value={p.source} />
      {p.triggerCtx ? (
        <Section
          label={t('detail.triggerContext')}
          value={<JsonBlock value={p.triggerCtx} />}
        />
      ) : null}
      <Section
        label={t('detail.userQuestion')}
        value={
          <CopyableBlock
            copyText={p.userText}
            className="whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-text-primary"
          >
            {p.userText}
          </CopyableBlock>
        }
      />
      {p.attachments && p.attachments.length > 0 ? (
        <Section
          label={t('detail.attachments', { count: p.attachments.length })}
          value={
            <ul className="space-y-1">
              {p.attachments.map((a, i) => (
                <li key={i} className="rounded bg-canvas px-2 py-1 text-xs text-text-secondary">
                  {a.name} <span className="text-text-tertiary">· {(a.bytes / 1024).toFixed(1)} KB · {a.path}</span>
                </li>
              ))}
            </ul>
          }
        />
      ) : null}
    </div>
  );
}

function Section({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{label}</div>
      <div className="text-text-primary">{value}</div>
    </div>
  );
}

function JsonBlock({ value }: { value: unknown }) {
  const str = JSON.stringify(value, null, 2);
  return (
    <CopyableBlock
      copyText={str}
      className="whitespace-pre-wrap break-all rounded-md bg-canvas p-2 text-xs text-text-secondary"
    >
      {str}
    </CopyableBlock>
  );
}
