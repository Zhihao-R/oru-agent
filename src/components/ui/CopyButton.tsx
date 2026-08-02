/**
 * 复制按钮（2026-07-19 对话页换皮）——工具参数/结果/命令原文统一补。
 * 点击复制 text，短暂显示对勾反馈。定位交调用方：命令块钉在右上角（`absolute`，容器需 relative），
 * 工具卡则用 `ml-auto` 排在 label 行右端。
 * 圆形走「单枚小图标按钮」约定，见设计词汇表 §3（docs/tech/2026-07-15-ui-ux-设计词汇表.md）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy } from 'lucide-react';

export function CopyButton({ text, className = '' }: { text: string; className?: string }) {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      // 非安全上下文（部分 Electron webview 权限）下 writeText 会 reject——静默兜住，别让 Promise 悬空
      .catch(() => undefined);
  };
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={t('copy.label')}
      title={t(copied ? 'copy.done' : 'copy.label')}
      className={`grid h-5 w-5 place-items-center rounded-full text-text-quaternary transition-colors hover:bg-sunken hover:text-text-secondary ${className}`}
    >
      {copied ? <Check size={11} strokeWidth={2} className="text-accent" /> : <Copy size={11} strokeWidth={1.5} />}
    </button>
  );
}
