import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
  /** 头部右上角、关闭键左侧的动作区（如「在 Oru 中打开」） */
  headerActions?: ReactNode;
}

/**
 * 模块级 Dialog 栈：只有最顶层 Dialog 响应 Escape。
 * 嵌套 Dialog（如详情 Modal 内的二次确认子 Dialog）不会让外层意外一起关。
 */
const dialogStack: Array<() => void> = [];

export function Dialog({ open, onClose, title, description, children, footer, className, headerActions }: DialogProps) {
  const { t } = useTranslation('common');
  useEffect(() => {
    if (!open) return;
    dialogStack.push(onClose);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 仅栈顶 Dialog 响应 Esc
      if (dialogStack[dialogStack.length - 1] !== onClose) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      const i = dialogStack.lastIndexOf(onClose);
      if (i >= 0) dialogStack.splice(i, 1);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  // 模态浮层挂到 body：脱离侧栏等带 transform 的祖先（transform 会成为 fixed 的包含块，
  // 否则浮层被裁进侧栏、并随侧栏 translate 一起隐藏/展开）。
  return createPortal(
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <motion.div
            className="absolute inset-0 bg-text-primary/20 backdrop-blur-[2px]"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={onClose}
          />
          <motion.div
            role="dialog"
            aria-modal="true"
            initial={{ opacity: 0, y: 8, scale: 0.99 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 4, scale: 0.99 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className={cn(
              'relative z-10 w-[min(420px,calc(100vw-32px))] overflow-hidden rounded-xl border border-border bg-elevated shadow-pop',
              className,
            )}
          >
            <header
              className={cn(
                'flex items-start justify-between gap-3 px-5 py-4',
                children ? 'border-b border-border' : null,
              )}
            >
              <div className="min-w-0">
                {title ? (
                  <h2 className="text-md font-medium tracking-tight text-text-primary">{title}</h2>
                ) : null}
                {description ? (
                  <p className="mt-1 text-xs text-text-tertiary">{description}</p>
                ) : null}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {headerActions}
                <IconButton size="sm" label={t('close')} onClick={onClose}>
                  <X size={14} strokeWidth={1.5} />
                </IconButton>
              </div>
            </header>
            {children ? <div className="px-5 py-4">{children}</div> : null}
            {footer ? (
              <footer className="flex items-center justify-end gap-2 border-t border-border bg-sunken/40 px-5 py-3">
                {footer}
              </footer>
            ) : null}
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
