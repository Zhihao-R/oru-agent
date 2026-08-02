/**
 * 任务描述文本编辑器（共用内核）——新建对话框与详情面板此前各写一套 textarea，收敛成一处。
 * 键位照 docs/plans/2026-07-15-任务板块优化方案.md 五·minor 表：
 *   ⌘/Ctrl+Enter 提交（onCommit）、Esc 撤销（onCancel）、Enter 换行、IME 选词态不触发。
 *
 * 只管文本：图片附件在新建（随任务提交的暂存图）与详情（即时增删）两处行为不同，
 * 由各 parent 在编辑器下方各自组合，不塞进本组件（避免把两套分叉流强并成一个）。
 * 边框 / ring 交给 caller 的 className——新建是常驻表单态、详情是「点开的激活态」，视觉不同。
 */
import { forwardRef, type ClipboardEventHandler, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type DescriptionEditorProps = {
  value: string;
  onChange: (v: string) => void;
  /** ⌘/Ctrl+Enter */
  onCommit?: () => void;
  /** Esc（详情行内编辑用；新建对话框的 Esc 由 Dialog 接管，不传） */
  onCancel?: () => void;
  onBlur?: () => void;
  /** 粘贴（插图：parent 传 picker.onPaste 让图片粘贴进描述） */
  onPaste?: ClipboardEventHandler<HTMLTextAreaElement>;
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  /** 底部提示（如键位说明） */
  hint?: ReactNode;
  /** 边框 / ring / 背景等由 caller 定 */
  className?: string;
};

export const DescriptionEditor = forwardRef<HTMLTextAreaElement, DescriptionEditorProps>(
  function DescriptionEditor(
    { value, onChange, onCommit, onCancel, onBlur, onPaste, placeholder, rows = 4, disabled, hint, className },
    ref,
  ) {
    return (
      <div>
        <textarea
          ref={ref}
          value={value}
          rows={rows}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          onPaste={onPaste}
          onKeyDown={(e) => {
            // IME 选词态不触发提交（避免发出未完成的拼音）
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onCommit?.();
            } else if (e.key === 'Escape' && onCancel) {
              onCancel();
            }
          }}
          placeholder={placeholder}
          className={cn(
            'block w-full resize-y rounded-md px-2.5 py-2 text-sm text-text-primary placeholder:text-text-tertiary outline-none transition-colors duration-150',
            className,
          )}
        />
        {hint ? <span className="mt-1 block text-[11px] text-text-tertiary">{hint}</span> : null}
      </div>
    );
  },
);
