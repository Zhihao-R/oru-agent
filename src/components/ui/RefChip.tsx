/**
 * composer 引用 chip：淡 accent 底 + 截断文本 + × 删除。无阴影、克制（参考 demo .chip）。
 * 对话输入栏与主页启动器输入栏共用——两处呈现同源，避免一端改了另一端漂移。
 *
 * 两种引用同一形状、只在前缀分叉：
 *   - kind='quote'（缺省）：quote 是选段原文，压成单行展示，title 给完整原文。
 *   - kind='file'：quote 是文件名，前置类型图标（与产物条 / 正文路径 chip 同一套图标语言），
 *     title 给完整相对路径——「引用了哪个文件」一眼可辨。
 */
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import type { ChatRef } from '@shared/types';
import { fileChipIcon } from '@/components/chat/fileChipIcon';
import { cn } from '@/lib/cn';

export function RefChip({ chatRef, onRemove }: { chatRef: ChatRef; onRemove: () => void }) {
  const { t } = useTranslation('chat');
  const isFile = chatRef.kind === 'file';
  const icon = isFile ? fileChipIcon(chatRef.sourcePath) : null;
  const oneLine = chatRef.quote.replace(/\s+/g, ' ').trim();
  return (
    <span
      title={isFile ? chatRef.sourcePath : chatRef.quote}
      className="inline-flex max-w-[180px] items-center gap-1 rounded-md bg-accent-soft py-0.5 pl-2 pr-1 text-xs text-accent"
    >
      {icon && <icon.Icon size={11} strokeWidth={1.8} className={cn('shrink-0', icon.className)} />}
      <span className="truncate opacity-90">{oneLine}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('input.removeRef')}
        className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
      >
        <X size={11} strokeWidth={2} />
      </button>
    </span>
  );
}
