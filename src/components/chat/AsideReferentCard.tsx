/**
 * 紧凑指代卡：kind:'aside-referent' 消息的渲染——浮层与正式对话同一个组件。
 * 从 asideReferent payload 还原（不渲染成用户气泡，message.text 是给模型的回放形态，不展示）：
 * - 文字类（selection / message / deck-page / 带文案的 control）：引用样式——
 *   来源行（label）+ 截断的内容预览，点击展开 / 收起全文；
 * - 画面类（blank / 无文案控件）：截图缩略图（消息附件 displayUrl）+ label，
 *   无图降级时只剩来源行。
 * 视觉对齐 hifi demo 的 .refcard：accent 左边线 + 来源行 + 引文，用项目 token。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AsideReferent, ChatMessage } from '@shared/types';
import { cn } from '@/lib/cn';

/** 文字类各成员的「原文预览」；画面类（blank / 无文案控件）返回 null → 走缩略图 */
function referentQuote(r: AsideReferent): string | null {
  switch (r.type) {
    case 'selection':
    case 'message':
    case 'deck-page':
      return r.text;
    case 'control':
      return r.caption ?? null;
    case 'blank':
    case 'screen':
      // 画面类：窗外指认无文本引文，走截图缩略图（无图降级时只剩来源行 label）
      return null;
  }
}

export function AsideReferentCard({
  message,
  className,
}: {
  message: ChatMessage;
  className?: string;
}) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const referent = message.asideReferent;
  // payload 缺失（脏数据）→ 退化为来源行占位，不阻断渲染
  const quote = referent ? referentQuote(referent) : null;
  const shot = message.attachments?.find((a) => a.displayUrl)?.displayUrl;
  return (
    <div
      className={cn(
        'max-w-[460px] rounded-lg border border-border border-l-[3px] border-l-accent bg-elevated px-3.5 py-2.5',
        className,
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-accent">
        <span aria-hidden>{quote ? '❝' : '⌖'}</span>
        <span className="truncate">{referent?.label ?? t('asideRef.label')}</span>
      </div>
      {quote ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => {
            // 选中引文复制时（select-text 鼓励的行为）mouseup 仍落在按钮内——
            // 有未塌缩选区就不翻转展开态，免得刚选的长文被 line-clamp 折回、选区作废
            if (!window.getSelection()?.isCollapsed) return;
            setExpanded((v) => !v);
          }}
          className="mt-1 block w-full select-text text-left text-base leading-relaxed text-text-secondary"
        >
          <span className={expanded ? undefined : 'line-clamp-3'}>{quote}</span>
        </button>
      ) : shot ? (
        // 画面类缩略图：点击放大与 AttachmentGallery 同口径
        <button
          type="button"
          onClick={() => window.open(shot, '_blank')}
          title={t('asideRef.zoom')}
          className="mt-1.5 block"
        >
          <img
            src={shot}
            alt={referent?.label ?? t('asideRef.shotAlt')}
            className="max-h-32 rounded border border-border object-cover"
          />
        </button>
      ) : null}
    </div>
  );
}
