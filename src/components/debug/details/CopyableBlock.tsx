/**
 * 可复制代码块——pre 容器 + 右上角悬浮复制按钮。
 *
 * 抽出原因：详情面板里 9 处 pre 块需要复制能力（JSON payload / 输出文本 / 错误 stack 等）。
 * 用一个组件承载样式 + 复制 + 反馈，让"加第二个"零成本。
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Check } from 'lucide-react';

export function CopyableBlock({
  className = '',
  children,
  copyText,
}: {
  className?: string;
  children: ReactNode;
  /** 点复制时写入剪贴板的文本——通常等于 children 的字符串形式 */
  copyText: string;
}) {
  const { t } = useTranslation('debug');
  const [copied, setCopied] = useState(false);

  async function onCopy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e) {
      console.warn('[CopyableBlock] copy failed', e);
    }
  }

  return (
    <div className="group relative">
      <pre className={className}>{children}</pre>
      <button
        type="button"
        onClick={onCopy}
        aria-label={copied ? t('detail.copied') : t('detail.copy')}
        className="absolute right-2 top-2 rounded-full p-1 text-text-tertiary opacity-0 transition-opacity hover:bg-hover hover:text-text-primary group-hover:opacity-100 focus-visible:opacity-100"
      >
        {copied ? (
          <Check size={14} strokeWidth={1.5} className="text-success" />
        ) : (
          <Copy size={14} strokeWidth={1.5} />
        )}
      </button>
    </div>
  );
}
