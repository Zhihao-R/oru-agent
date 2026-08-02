/**
 * 上下文压缩通知卡（v0.2）
 *
 * 由 chat.contextCompressed 事件触发。形态参考 MemoryRecordCard 但更淡——
 * 不用 accent 色，用 border-border + bg-elevated/30 中性色。
 *
 * 折叠态：单行图标 + 简短文字（"对话较长，已自动压缩早期 N 轮内容为摘要"）
 * 展开态：上方"摘要全文"，下方"被压缩的原文消息列表"
 *
 * fallback=true（摘要 model 调用失败回退到硬丢）：文案改"摘要生成失败…"，展开后只有原文列表
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { ChevronRight, Layers } from 'lucide-react';
import type { ChatMessage } from '@shared/types';
import { useChatStore } from '@/stores/chatStore';
import { cn } from '@/lib/cn';
import { useOruName } from '@/lib/oruName';

type Props = {
  message: ChatMessage; // kind === 'context-compressed'
};

export function ContextCompressedCard({ message }: Props) {
  const { t } = useTranslation('chat');
  // 压缩卡里的原文消息都属当前活跃对话（chat 单活跃 conv：activeConv=active agent 的 conv），
  // 故 active 名即这些消息的上下文 agent 名——满足 oruName「绑定上下文传该 agent 名」约定。
  const oruName = useOruName();
  const payload = message.contextCompressed;
  const [expanded, setExpanded] = useState(false);

  const allMessages = useChatStore(
    (s) => s.conversations[message.conversationId] ?? [],
  );

  if (!payload) return null;

  const compressedCount = payload.compressedMessageIds.length;
  const isFallback = payload.fallback === true;

  return (
    <div className="rounded-sm border border-border bg-elevated/30 px-4 py-3 text-sm">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-3 text-left text-text-secondary transition-colors hover:text-text-primary"
      >
        <Layers size={14} strokeWidth={1.5} className="shrink-0 text-text-tertiary" />
        <span className="flex-1 text-xs">{message.text}</span>
        <ChevronRight
          size={14}
          strokeWidth={1.5}
          className={cn(
            'shrink-0 text-text-tertiary transition-transform duration-150',
            expanded && 'rotate-90',
          )}
        />
      </button>

      {expanded ? (
        <div className="mt-3 flex flex-col gap-3 border-t border-border pt-3">
          {!isFallback && payload.summaryText ? (
            <section>
              <div className="mb-1 text-xs uppercase tracking-wide text-text-tertiary">
                {t('compressed.summary')}
              </div>
              <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-primary">
                {payload.summaryText}
              </p>
            </section>
          ) : null}
          <section>
            <div className="mb-1 text-xs uppercase tracking-wide text-text-tertiary">
              {t('compressed.originalCount', { count: compressedCount })}
            </div>
            <ul className="flex flex-col gap-1.5">
              {payload.compressedMessageIds.map((id) => {
                const orig = allMessages.find((m) => m.id === id);
                if (!orig) {
                  return (
                    <li key={id} className="text-xs text-text-tertiary">
                      {t('compressed.messageGone', { id })}
                    </li>
                  );
                }
                const role = roleLabel(orig.role, oruName, t);
                const preview =
                  orig.text.length > 80
                    ? orig.text.slice(0, 80) + '…'
                    : orig.text;
                return (
                  <li key={id} className="text-xs leading-relaxed text-text-secondary">
                    <span className="text-text-tertiary">{t('compressed.rolePrefix', { role })}</span>
                    <span>{preview || t('compressed.noText')}</span>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function roleLabel(role: ChatMessage['role'], name: string, t: TFunction): string {
  if (role === 'user') return t('compressed.roleUser');
  if (role === 'assistant') return t('compressed.roleAssistant', { name });
  return t('compressed.roleSystem');
}
