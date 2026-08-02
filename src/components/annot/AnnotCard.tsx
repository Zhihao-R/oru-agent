import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Trash2 } from 'lucide-react';
import type { Annotation } from '@shared/types';
import { cropAssetUrl } from '@/lib/fileUrl';
import { cn } from '@/lib/cn';

/**
 * 框选卡（deck/html 共用叶子组件，项目B 第三期 Task15）
 *
 * 头行 [勾选 · #编号 · 页码 ···· 删除]，下方注释输入。crop 图与捕获详情不占列表，
 * hover 卡片时在左侧浮现（fixed 定位逃出列表 overflow 裁剪）。crop 走 oru-crop:// 协议。
 *
 * 纯数据驱动、不绑 artifactId：crop URL base 由 `cropBaseDir` 决定（deck=deckPath，html=文件所在目录）。
 */
export type AnnotCardProps = {
  annotation: Annotation;
  /** crop 图 URL 前缀：cropAssetUrl(`${cropBaseDir}/${cropPath}`) */
  cropBaseDir: string;
  /** 1 起的显示编号 */
  index: number;
  checked: boolean;
  /** null = 不可勾（submitted/failed） */
  onToggle: (() => void) | null;
  /** null = 只读（submitted） */
  onSaveComment: ((text: string) => void) | null;
  onJump: () => void;
  /** null = 不可删（组内卡） */
  onDelete: (() => void) | null;
};

export function AnnotCard({
  annotation,
  cropBaseDir,
  index,
  checked,
  onToggle,
  onSaveComment,
  onJump,
  onDelete,
}: AnnotCardProps) {
  const { t } = useTranslation('annot');
  // 受控草稿——失焦才提交；annotation.comment 外部变化时同步（外部更新优先）
  const [draft, setDraft] = useState(annotation.comment);
  useEffect(() => {
    setDraft(annotation.comment);
  }, [annotation.comment]);

  // hover 预览用 fixed 定位（列表容器 overflow-y-auto 会连带裁剪横向溢出，absolute 会被切掉）。
  // 进卡时按卡片 rect 算锚点，浮层贴在卡片左侧。
  const liRef = useRef<HTMLLIElement>(null);
  const [popover, setPopover] = useState<{ top: number; left: number } | null>(null);
  const openPopover = () => {
    const r = liRef.current?.getBoundingClientRect();
    if (r) setPopover({ top: r.top, left: r.left });
  };

  const isFailed = annotation.status === 'failed';
  const cropUrl = annotation.cropPath ? cropAssetUrl(`${cropBaseDir}/${annotation.cropPath}`) : '';
  const readOnly = onSaveComment === null;
  const pageIndex = annotation.locator.pageIndex;

  return (
    <li
      ref={liRef}
      onMouseEnter={openPopover}
      onMouseLeave={() => setPopover(null)}
      className={cn(
        'group relative rounded-xs p-2 transition-colors',
        isFailed ? 'bg-danger-soft' : checked ? 'bg-accent-soft' : '',
      )}
    >
      {/* 头行：#N 编号 chip（兼作选中，砍独立 checkbox）· 定位（框选/捕获文本，点击跳转）···· 删除 */}
      <div className="mb-1.5 flex items-center gap-1.5">
        {onToggle ? (
          // 可选：chip 即选中开关——未选空心描边、选中 accent 实心
          <button
            type="button"
            onClick={onToggle}
            title={t('selectTitle')}
            className={cn(
              'shrink-0 rounded-xs px-1.5 font-mono text-2xs leading-4 tabular-nums transition-colors',
              checked
                ? 'bg-accent text-accent-fg'
                : 'text-text-tertiary shadow-[inset_0_0_0_1px_var(--border-strong)] hover:text-text-secondary',
            )}
          >
            #{index}
          </button>
        ) : (
          // 不可选（已提交/组内卡）：静态编号，失败染红、否则 accent
          <span
            className={cn(
              'shrink-0 rounded-xs px-1.5 font-mono text-2xs leading-4 tabular-nums',
              isFailed ? 'text-danger' : 'text-accent',
            )}
          >
            #{index}
          </span>
        )}
        {pageIndex != null ? (
          // 演示稿：页码在分组头，卡内只标「框选」类型
          <span className="shrink-0 text-2xs text-text-quaternary">{t('frameSelect')}</span>
        ) : annotation.text ? (
          // 网页（无页码）：捕获文本摘要作定位徽记，点击滚动到对应区块
          <button
            type="button"
            onClick={onJump}
            title={t('jumpTitle')}
            className="min-w-0 truncate text-2xs text-text-quaternary transition-colors hover:text-accent-deep"
          >
            「{annotation.text}」{t('nearSuffix')}
          </button>
        ) : null}
        <span className="flex-1" />
        {onDelete ? (
          <button
            type="button"
            onClick={onDelete}
            title={t('deleteTitle')}
            className="text-text-quaternary opacity-0 transition hover:text-danger group-hover:opacity-100"
          >
            <Trash2 size={13} strokeWidth={1.6} />
          </button>
        ) : null}
      </div>

      {/* 注释输入 / 只读 */}
      {readOnly ? (
        <p className="whitespace-pre-wrap break-words px-2 py-1.5 text-xs leading-relaxed text-text-primary">
          {annotation.comment || <span className="text-text-tertiary">{t('noComment')}</span>}
        </p>
      ) : (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (onSaveComment && draft !== annotation.comment) onSaveComment(draft);
          }}
          placeholder={t('commentPlaceholder')}
          rows={2}
          className="w-full resize-none rounded-md border border-transparent bg-transparent px-2 py-1.5 text-xs leading-relaxed text-text-primary placeholder:text-text-tertiary transition-colors hover:bg-sunken/40 focus:border-accent focus:bg-sunken/70 focus:outline-none"
        />
      )}
      {isFailed && annotation.failureMessage && (
        <div className="mt-1 px-0.5 text-2xs text-danger">{annotation.failureMessage}</div>
      )}

      {/* hover 预览浮层（fixed，逃出 overflow 裁剪）：crop 截图 + 「捕获文本:「…」」（200px，对齐设计稿） */}
      {popover && (
        <div
          style={{ position: 'fixed', top: popover.top, left: popover.left - 8, transform: 'translateX(-100%)' }}
          className="pointer-events-none z-50 w-[200px] overflow-hidden rounded border border-border-strong bg-elevated shadow-pop"
        >
          {cropUrl ? (
            <img src={cropUrl} alt="" className="max-h-72 w-full bg-white object-contain" />
          ) : (
            <div className="bg-sunken py-6 text-center text-2xs text-text-tertiary">{t('noCrop')}</div>
          )}
          {annotation.text && (
            <div className="line-clamp-3 break-words px-2.5 py-1.5 text-2xs leading-relaxed text-text-tertiary">
              {t('capturedText', { text: annotation.text })}
            </div>
          )}
        </div>
      )}
    </li>
  );
}
