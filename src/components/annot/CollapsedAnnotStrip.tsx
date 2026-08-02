import { ChevronsLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * 批注栏收起态的右缘竖直细条——展开按钮 + 待处理标注计数，点任意处展开。
 * deck 预览与 html 预览共用同一视觉契约（同标志、同 i18n、同计数口径）；这里只封纯展示，
 * 外层「何时进入收起态」的渲染条件留在各自布局分支。
 */
export function CollapsedAnnotStrip({ count, onExpand }: { count: number; onExpand: () => void }) {
  const { t } = useTranslation('app');
  return (
    <button
      type="button"
      onClick={onExpand}
      title={t('expandAnnot')}
      aria-label={t('expandAnnot')}
      className="flex w-8 shrink-0 cursor-pointer flex-col items-center gap-2 border-l border-border bg-sunken/40 py-3 text-text-tertiary transition hover:bg-hover hover:text-text-secondary"
    >
      <ChevronsLeft size={14} strokeWidth={1.5} />
      {count > 0 ? (
        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-accent-soft text-[10px] font-medium tabular-nums text-accent">
          {count}
        </span>
      ) : null}
      <span className="[writing-mode:vertical-rl] text-[10px] tracking-wider">{t('annotLabel')}</span>
    </button>
  );
}
