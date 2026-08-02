import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * 标签的关闭 ✕——标签栏与溢出菜单共用（同 KindIcon 的理由：两个消费者，尺寸与图标只该有一处）。
 * 这里的默认配色是给「有独立位置」的场景用的（溢出菜单）；标签栏里 ✕ 是盖在文件名上的，
 * 需要不透明底和更强的对比，由那边经 className 覆写（见 TabBar 的注释）。
 */
export function TabCloseButton({
  title,
  onClose,
  className,
}: {
  title: string;
  onClose: () => void;
  className?: string;
}): JSX.Element {
  const { t } = useTranslation('app');
  return (
    <button
      type="button"
      aria-label={t('closeTab', { title })}
      onClick={(e) => {
        e.stopPropagation(); // 栏里 ✕ 嵌在可点击的标签内，不阻止会顺带激活它
        onClose();
      }}
      className={cn(
        'flex h-4 w-4 shrink-0 items-center justify-center rounded-xs text-text-quaternary hover:bg-hover hover:text-text-secondary',
        className,
      )}
    >
      <X className="h-[10px] w-[10px]" strokeWidth={1.6} />
    </button>
  );
}
