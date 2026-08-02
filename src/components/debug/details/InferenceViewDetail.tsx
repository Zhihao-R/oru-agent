/**
 * inference_view 详情——展示 savings 计数器 + adapter 之后的真实入参（wireHistory）。
 *
 * 三种状态由 getWireHistoryDisplay helper 区分：
 * - present：按消息渲染 wireHistory；block 按 role 严格分组（user / assistant）
 * - resume：claudeCode 原生续 session 路径，adapter 未跑——显示降级提示
 * - legacy：老 ndjson 缺字段——显示降级提示
 */
import { useTranslation } from 'react-i18next';
import type { DebugRecord } from '@shared/debug/types';
import type {
  AssistantBlock,
  NormalizedMessage,
  UserBlock,
} from '@shared/agent/normalizedMessage';
import { getWireHistoryDisplay } from '@/lib/debug/wireHistory';
import { CopyableBlock } from './CopyableBlock';

export function InferenceViewDetail({ record }: { record: DebugRecord<'inference_view'> }) {
  const { t } = useTranslation('debug');
  const p = record.payload;
  const s = p.savings;
  const display = getWireHistoryDisplay(record);
  // 一行 summary：裁剪启用情况 + 总条数 + 字符节省（PRD 只承诺"顶部仍是 savings"，
  // 不平铺 6 格 schema 字段——保留信息密度，不抢入参主场）
  const cutTotal = s.systemMessagesFiltered + s.persistedReplaced + s.writeAckDeduped;
  const charsTotal = s.persistedCharsReduced + s.writeAckCharsReduced;
  const savingsLine = !p.enabled
    ? t('detail.infDisabled')
    : cutTotal === 0
      ? t('detail.infEnabledNoCut')
      : t('detail.infCutDetail', {
          cut: cutTotal,
          sys: s.systemMessagesFiltered,
          persisted: s.persistedReplaced,
          writeback: s.writeAckDeduped,
          chars: charsTotal.toLocaleString(),
        });
  return (
    <div className="space-y-3 text-sm">
      <div className="rounded-md border border-border bg-canvas/50 px-2 py-1.5 text-xs text-text-secondary">
        {savingsLine}
      </div>
      <div>
        <div className="mb-1 text-xs uppercase tracking-wider text-text-tertiary">
          {t('detail.realInput')}
        </div>
        {display.kind === 'present' ? (
          <div className="space-y-2">
            {display.messages.map((m, i) => (
              <WireMessage key={i} message={m} index={i} />
            ))}
          </div>
        ) : display.kind === 'resume' ? (
          <DegradeNote text={t('detail.degradeResume')} />
        ) : (
          <DegradeNote text={t('detail.degradeLegacy')} />
        )}
      </div>
    </div>
  );
}

function WireMessage({ message, index }: { message: NormalizedMessage; index: number }) {
  return (
    <details className="rounded-md border border-border bg-canvas/50">
      <summary className="cursor-pointer select-none px-2 py-1.5 text-xs">
        <span className="font-mono text-text-secondary">#{index}</span>
        <span className="ml-2 rounded bg-canvas px-1.5 py-0.5 text-text-primary">
          {message.role}
        </span>
        <span className="ml-2 text-text-tertiary">(blocks: {message.blocks.length})</span>
      </summary>
      <div className="space-y-1.5 border-t border-border p-2">
        {message.role === 'user'
          ? (message.blocks as UserBlock[]).map((b, i) => <UserBlockView key={i} block={b} />)
          : (message.blocks as AssistantBlock[]).map((b, i) => (
              <AssistantBlockView key={i} block={b} />
            ))}
      </div>
    </details>
  );
}

function UserBlockView({ block }: { block: UserBlock }) {
  if (block.type === 'text') {
    return <TextBlock text={block.text} />;
  }
  if (block.type === 'tool_result') {
    const cls = block.isError
      ? 'whitespace-pre-wrap break-words rounded-md bg-danger-soft p-2 text-danger'
      : 'whitespace-pre-wrap break-words rounded-md bg-success-soft p-2 text-text-primary';
    return (
      <div>
        <BlockLabel
          label={`tool_result · ${block.toolUseId}${block.isError ? ' · error' : ''}`}
        />
        <CopyableBlock copyText={block.content} className={cls}>
          {block.content}
        </CopyableBlock>
      </div>
    );
  }
  // image
  return (
    <div className="text-xs text-text-tertiary">
      [image: {block.filename} · {block.mediaType}]
    </div>
  );
}

function AssistantBlockView({ block }: { block: AssistantBlock }) {
  if (block.type === 'text') {
    return <TextBlock text={block.text} />;
  }
  const inputJson = JSON.stringify(block.input, null, 2);
  return (
    <div>
      <BlockLabel label={`tool_use · ${block.name} · ${block.id}`} />
      <CopyableBlock
        copyText={inputJson}
        className="whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-xs text-text-primary"
      >
        {inputJson}
      </CopyableBlock>
    </div>
  );
}

function TextBlock({ text }: { text: string }) {
  return (
    <div>
      <BlockLabel label="text" />
      <CopyableBlock
        copyText={text}
        className="whitespace-pre-wrap break-words rounded-md bg-canvas p-2 text-text-primary"
      >
        {text}
      </CopyableBlock>
    </div>
  );
}

function BlockLabel({ label }: { label: string }) {
  return <div className="mb-1 font-mono text-[10px] uppercase text-text-tertiary">{label}</div>;
}

function DegradeNote({ text }: { text: string }) {
  return (
    <div className="rounded-md border border-border bg-canvas/50 p-2 text-xs text-text-tertiary">
      {text}
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
