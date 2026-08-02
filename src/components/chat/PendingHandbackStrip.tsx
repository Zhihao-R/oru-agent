/**
 * 待处理项条（S08 · G14）——回合因故障 / 中断 / 崩溃异常结束时，机器触发与渠道消息交还成待处理项，
 * 列在 composer 上方，每条两个动作：放行（重新入队起回合）/ 清掉（前端丢弃）。
 *
 * 与草稿分流的边界见 handbackForm：桌面用户亲手打的字回填输入框、不进这里。条目正文即触发原文
 * （数据、不翻）；类型标签与动作走 i18n。
 */
import { useTranslation } from 'react-i18next';
import type { HandbackItem } from '@shared/types';
import { useChatStore } from '@/stores/chatStore';

const EMPTY: HandbackItem[] = [];

/** 类型标签：机器触发 / 渠道消息，只翻标签本身，正文是数据。 */
function itemLabel(item: HandbackItem, t: (k: string) => string): string {
  if (item.origin) return t('pendingHandback.channel');
  if (item.trigger === 'task-completed') return t('pendingHandback.taskCompleted');
  if (item.trigger === 'scheduled') return t('pendingHandback.scheduled');
  return t('pendingHandback.channel');
}

/** 正文预览：定时任务取任务名（触发卡口径），否则取原文首行。 */
function itemPreview(item: HandbackItem): string {
  if (item.scheduledTrigger?.title) return item.scheduledTrigger.title;
  return (item.text.split('\n').find((l) => l.trim().length > 0) ?? item.text).trim();
}

export function PendingHandbackStrip({ conversationId }: { conversationId: string | null }) {
  const { t } = useTranslation('chat');
  const items = useChatStore((s) =>
    conversationId ? s.pendingHandbackByConv[conversationId] ?? EMPTY : EMPTY,
  );
  const readmitPending = useChatStore((s) => s.readmitPending);
  const dismissPending = useChatStore((s) => s.dismissPending);

  if (!conversationId || items.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 rounded-xl border border-border bg-elevated px-3 py-2">
      <span className="text-xs text-text-tertiary">{t('pendingHandback.heading')}</span>
      {items.map((item) => (
        <div key={item.serverId} className="flex items-center gap-2">
          <span className="shrink-0 rounded bg-surface px-1.5 py-0.5 text-xs text-text-secondary">
            {itemLabel(item, t)}
          </span>
          <span className="flex-1 truncate text-sm text-text-primary">{itemPreview(item)}</span>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-0.5 text-xs text-accent hover:bg-accent-soft"
            onClick={() => readmitPending(conversationId, item)}
          >
            {t('pendingHandback.readmit')}
          </button>
          <button
            type="button"
            className="shrink-0 rounded px-2 py-0.5 text-xs text-text-tertiary hover:bg-surface"
            onClick={() => dismissPending(conversationId, item)}
          >
            {t('pendingHandback.dismiss')}
          </button>
        </div>
      ))}
    </div>
  );
}
