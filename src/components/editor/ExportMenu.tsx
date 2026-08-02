import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode, FileText } from 'lucide-react';

/**
 * 编辑器工具条「导出」下拉——两种出口（HTML 自包含单文件 / PDF），PDF 项下挂「纸张版（A4）」开关。
 * 与 NewFileMenu 同一视觉语言与关闭交互（outside click + Esc + 滚动），锚按钮下沿、右对齐。
 *
 * 克制：只有「选格式 + 一个纸张版开关」，不暴露页边距/缩放/纸张尺寸/主题这类旋钮（PRD 不做导出参数面板）。
 */
export type ExportFormat = 'html' | 'pdf';

export function ExportMenu({
  anchor,
  paperMode,
  onPaperModeChange,
  onPick,
  onClose,
}: {
  anchor: DOMRect;
  paperMode: boolean;
  onPaperModeChange: (v: boolean) => void;
  onPick: (format: ExportFormat) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('editor');
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const m = menuRef.current;
    const h = m?.offsetHeight ?? 120;
    const w = m?.offsetWidth ?? 200;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = anchor.bottom + 4;
    let left = anchor.right - w;
    if (top + h > vh - 8) top = Math.max(8, anchor.top - h - 4);
    if (left < 8) left = 8;
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    setPos({ top, left });
  }, [anchor]);

  useEffect(() => {
    const onMouseDown = (e: MouseEvent): void => {
      const target = e.target as Node | null;
      if (target && menuRef.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onClose, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      role="menu"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className="fixed z-50 min-w-[190px] overflow-hidden rounded-md border border-border bg-elevated py-1 shadow-pop"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => onPick('html')}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-primary transition-colors hover:bg-hover"
      >
        <FileCode className="h-3.5 w-3.5 shrink-0 text-text-tertiary" strokeWidth={1.5} />
        <span>{t('exportMenu.html')}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => onPick('pdf')}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-primary transition-colors hover:bg-hover"
      >
        <FileText className="h-3.5 w-3.5 shrink-0 text-text-tertiary" strokeWidth={1.5} />
        <span>{t('exportMenu.pdf')}</span>
      </button>
      {/* PDF 子项：纸张版开关。点开关只改状态、不导出（导出由点 PDF 触发）。 */}
      <label className="flex cursor-pointer items-center gap-2 py-1.5 pl-8 pr-2.5 text-xs text-text-secondary transition-colors hover:bg-hover">
        <input
          type="checkbox"
          checked={paperMode}
          onChange={(e) => onPaperModeChange(e.target.checked)}
          className="h-3 w-3"
          style={{ accentColor: 'var(--accent)' }}
        />
        <span>{t('exportMenu.paperMode')}</span>
      </label>
    </div>
  );
}
