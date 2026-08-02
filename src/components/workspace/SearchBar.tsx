/**
 * 查找条 —— 输入框 + 命中计数 + 上下跳 + 关闭。PDF 与表格共用。
 *
 * 译者用 prop 注入而非组件内 useTranslation：两个宿主的文案本就该各自贴切
 *（PDF 是「在文档中搜索」，表格是「在表格中查找」），键留在各自的 namespace 里，
 * 提取时不必动已上线的 PDF 侧。宿主各自提供 search.{placeholder,count,none,prev,next,close}。
 */
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';

export function SearchBar({
  query,
  count,
  active,
  onQuery,
  onPrev,
  onNext,
  onClose,
  t,
}: {
  query: string;
  count: number;
  /** 当前命中的 0-based 下标；展示时 +1 */
  active: number;
  onQuery: (q: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  t: (k: string, o?: Record<string, unknown>) => string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-elevated px-2 py-1 focus-within:border-accent focus-within:ring-2 focus-within:ring-accent-ring">
      <Search className="h-3.5 w-3.5 shrink-0 text-text-tertiary" strokeWidth={1.5} />
      <input
        autoFocus
        value={query}
        placeholder={t('search.placeholder')}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.shiftKey ? onPrev() : onNext();
          } else if (e.key === 'Escape') onClose();
        }}
        className="w-40 min-w-0 bg-transparent text-xs text-text-primary outline-none"
      />
      <span className="shrink-0 text-[11px] tabular-nums text-text-tertiary">
        {query
          ? count
            ? t('search.count', { current: active + 1, count })
            : t('search.none')
          : ''}
      </span>
      <button type="button" onClick={onPrev} disabled={!count} title={t('search.prev')} className="text-text-tertiary hover:text-text-secondary disabled:opacity-40">
        <ChevronUp className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
      <button type="button" onClick={onNext} disabled={!count} title={t('search.next')} className="text-text-tertiary hover:text-text-secondary disabled:opacity-40">
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
      <button type="button" onClick={onClose} title={t('search.close')} className="text-text-tertiary hover:text-text-secondary">
        <X className="h-3.5 w-3.5" strokeWidth={1.5} />
      </button>
    </div>
  );
}
