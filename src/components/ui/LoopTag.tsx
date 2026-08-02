/**
 * Loop 模式标签：内联在输入框文字开头的命令 chip，`⟳ /loop ×`。淡 accent 底、与 loop 按钮同色系呼应。
 * `/loop` 是命令字面量（backend parseLoopCommand 契约的一部分），按数据哨兵处理不翻译；仅删除 aria 走 i18n。
 * 两处 composer（对话 ChatInput / 主页 LauncherInput）共用，保证「点亮即现标签」体感一致。
 */
import { useTranslation } from 'react-i18next';
import { Repeat, X } from 'lucide-react';

export function LoopTag({ onRemove }: { onRemove: () => void }) {
  const { t } = useTranslation('chat');
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-accent-soft py-0.5 pl-1.5 pr-1 text-xs font-medium text-accent">
      <Repeat size={11} strokeWidth={2} />
      <span>/loop</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={t('input.loopRemove')}
        className="shrink-0 rounded p-0.5 opacity-60 transition-opacity hover:opacity-100"
      >
        <X size={11} strokeWidth={2} />
      </button>
    </span>
  );
}
