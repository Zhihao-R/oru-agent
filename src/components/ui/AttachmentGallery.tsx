/**
 * 消息里已发送图片的展示网格（点击应用内看大图）。聊天气泡 / 评论行 / 任务描述共用。
 * align：聊天 user 气泡右对齐用 'end'，评论 / 描述左对齐用 'start'。
 * displayUrl 缺失（越界 / 脏数据）时退化为文件名占位，不阻断渲染。
 * 点缩略图 → ImageLightbox 应用内弹窗（替代旧的 window.open 新标签页）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X as XIcon } from 'lucide-react';
import type { ChatAttachment } from '@shared/types';
import { cn } from '@/lib/cn';
import { ImageLightbox } from './ImageLightbox';

export function AttachmentGallery({
  attachments,
  align = 'start',
  onRemove,
}: {
  attachments: ChatAttachment[];
  align?: 'start' | 'end';
  /** 传入即为可编辑态：每张缩略图 hover 现移除 X（任务描述图编辑用；聊天 / 评论只读不传） */
  onRemove?: (attachment: ChatAttachment) => void;
}) {
  const { t } = useTranslation('common');
  const [zoom, setZoom] = useState<{ src: string; alt: string } | null>(null);
  if (attachments.length === 0) return null;
  return (
    <>
      <div className={cn('flex flex-wrap gap-1.5', align === 'end' ? 'justify-end' : 'justify-start')}>
        {attachments.map((a, i) =>
          a.displayUrl ? (
            <div key={a.relPath || a.filename || i} className="group relative">
              <button
                type="button"
                onClick={() => setZoom({ src: a.displayUrl!, alt: a.filename })}
                title={`${a.filename}${t('attachment.zoomHint')}`}
                className="block"
              >
                <img
                  src={a.displayUrl}
                  alt={a.filename}
                  className="h-24 max-w-[160px] rounded border border-border object-cover"
                />
              </button>
              {onRemove ? (
                <button
                  type="button"
                  onClick={() => onRemove(a)}
                  title={t('remove')}
                  className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-canvas p-0.5 text-text-secondary opacity-0 transition-opacity group-hover:opacity-100 hover:text-danger"
                >
                  <XIcon size={12} strokeWidth={1.8} />
                </button>
              ) : null}
            </div>
          ) : (
            <span
              key={a.relPath || a.filename || i}
              className="rounded border border-border bg-canvas px-2 py-1 text-xs text-text-tertiary"
            >
              📎 {a.filename}
            </span>
          ),
        )}
      </div>
      <ImageLightbox src={zoom?.src ?? null} alt={zoom?.alt} onClose={() => setZoom(null)} />
    </>
  );
}
