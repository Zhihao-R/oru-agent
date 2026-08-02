import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { FileText, Folder, Table2 } from 'lucide-react';
import type { NewKind } from '@/stores/fsStore';

/**
 * 「文件」标题行 + 按钮弹出的新建菜单——三项固定动作（Markdown / CSV / 文件夹）。
 *
 * 与 FileTreeContextMenu 同一视觉语言、同一关闭交互（outside click + Esc + 滚动），
 * 区别只在锚点：右键菜单锚鼠标坐标，这里锚 + 按钮的下沿（传入按钮 rect）。
 */
export type NewFileMenuProps = {
  anchor: DOMRect;
  onPick: (kind: NewKind) => void;
  onClose: () => void;
};

const ITEMS: { kind: NewKind; icon: typeof FileText }[] = [
  { kind: 'md', icon: FileText },
  { kind: 'csv', icon: Table2 },
  { kind: 'folder', icon: Folder },
];

// 「+」下拉与文件树右键是同一新建动作的两个入口（都落 beginNew→同一 NewKind）：
// md/folder 字面相同→复用右键的 menu.new*（单一源）；csv 在此为「新建 CSV 表格」、
// 右键为「新建表格」——历史分歧，第 2 期各保字面，单独取键（见 glossary 同义异形）。
const LABEL_KEY: Record<NewKind, string> = {
  md: 'menu.newMd',
  csv: 'newMenuCsv',
  folder: 'menu.newFolder',
};

export function NewFileMenu({ anchor, onPick, onClose }: NewFileMenuProps): JSX.Element {
  const { t } = useTranslation('files');
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 锚到按钮下沿、右对齐；首帧量真实尺寸再 viewport clamp
  useLayoutEffect(() => {
    const m = menuRef.current;
    const h = m?.offsetHeight ?? 100;
    const w = m?.offsetWidth ?? 160;
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

  // 经 createPortal 挂到 body：侧栏祖先带 transform（自动隐藏浮层的 translate 动画），会成为
  // fixed 的包含块，让菜单错位到祖先坐标系。同 FileTreeContextMenu。
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className="fixed z-50 min-w-[150px] overflow-hidden rounded-md border border-border bg-elevated py-1 shadow-pop"
    >
      {ITEMS.map((it) => (
        <button
          key={it.kind}
          type="button"
          role="menuitem"
          onClick={() => {
            onClose();
            onPick(it.kind);
          }}
          className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-primary transition-colors hover:bg-hover"
        >
          <it.icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" strokeWidth={1.5} />
          <span>{t(LABEL_KEY[it.kind])}</span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
