/**
 * 输入框里的待发送图片缩略图条（可移除）。聊天与评论输入框共用。
 */
import { useTranslation } from 'react-i18next';
import { X as XIcon } from 'lucide-react';
import type { PendingAttachment } from '@/lib/imageAttachments';

export function AttachmentStrip({
  items,
  onRemove,
}: {
  items: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation('common');
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {items.map((a) => (
        <div key={a.id} className="group relative">
          <img
            src={a.displayUrl}
            alt={a.file.name}
            className="h-16 w-16 rounded border border-border object-cover"
          />
          <button
            type="button"
            onClick={() => onRemove(a.id)}
            className="absolute -right-1.5 -top-1.5 rounded-full bg-canvas border border-border p-0.5 text-text-secondary opacity-0 group-hover:opacity-100 hover:text-danger"
            title={t('remove')}
          >
            <XIcon size={12} strokeWidth={1.8} />
          </button>
        </div>
      ))}
    </div>
  );
}
