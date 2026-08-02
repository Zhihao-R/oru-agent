/**
 * LLM 调用详情——展示 callIndex / model / token / firstTokenMs / outputText
 */
import { useTranslation } from 'react-i18next';
import type { DebugRecord } from '@shared/debug/types';
import { fmtDuration } from '@/lib/fmtDuration';
import { CopyableBlock } from './CopyableBlock';

export function LlmCallDetail({ record }: { record: DebugRecord<'llm_call_done'> }) {
  const { t } = useTranslation('debug');
  const p = record.payload;
  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('detail.callIndex')} value={`#${p.callIndex}`} />
        <Field label={t('detail.duration')} value={fmtDuration(p.durationMs)} />
        {p.firstTokenMs !== undefined ? (
          <Field label={t('detail.firstTokenLatency')} value={fmtDuration(p.firstTokenMs)} />
        ) : null}
        {p.inputTokens !== undefined ? (
          <Field label="input token" value={p.inputTokens.toLocaleString()} />
        ) : null}
        {p.outputTokens !== undefined ? (
          <Field label="output token" value={p.outputTokens.toLocaleString()} />
        ) : null}
        {/* cacheReadTokens 三态：undefined → 不显示（前端默认就是 token 不可见的语境）；0 → 「0」；>0 → 数字
            命中率仅当 inputTokens 已知且为正时附带展示——分母同时存在的语境下"x / 总输入"才有意义。
            backend 侧已把 inputTokens 口径统一为"总输入"（含 cache_read + cache_creation），所以这里直接除即可。 */}
        {p.cacheReadTokens !== undefined ? (
          <Field
            label={t('detail.cacheHit')}
            value={
              p.inputTokens !== undefined && p.inputTokens > 0
                ? `${p.cacheReadTokens.toLocaleString()} (${((p.cacheReadTokens / p.inputTokens) * 100).toFixed(1)}%)`
                : p.cacheReadTokens.toLocaleString()
            }
          />
        ) : null}
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">{t('detail.outputText')}</div>
        {p.outputText ? (
          <CopyableBlock
            copyText={p.outputText}
            className="whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-text-primary"
          >
            {p.outputText}
          </CopyableBlock>
        ) : (
          <pre className="whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-text-primary">
            <span className="text-text-tertiary">{t('detail.noTextOutput')}</span>
          </pre>
        )}
      </div>
      <div className="rounded-md border border-border bg-canvas/50 p-2 text-xs text-text-tertiary">
        💡 <strong>{t('detail.notShownHere')}</strong>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          <li>{t('detail.notShownSystemPrompt')}</li>
          <li>{t('detail.notShownWireHistory')}</li>
          <li>{t('detail.notShownTotals')}</li>
        </ul>
        {p.inputTokens === undefined ? <p className="mt-1">{t('detail.tokenUnavailable')}</p> : null}
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
