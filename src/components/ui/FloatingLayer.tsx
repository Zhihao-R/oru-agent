import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

/**
 * 浮层壳：锚到视口坐标（clientX/clientY）+ viewport clamp，portal 挂 body
 * （逃出侧栏 transform 包含块 / 查看器 overflow），outside click / Esc / 滚动关闭。
 * 右键菜单（ContextMenu）与工具条下拉（ToolbarSelect）共用——调用方只管攒 children，
 * 定位 / 关闭 / portal / 容器 chrome 都收在这里，「加第 N 个浮层零成本」。
 * 语义（role=menu / listbox）与内容由调用方给，壳只管定位与容器外观。
 */
export function FloatingLayer({
  x,
  y,
  onClose,
  role,
  className,
  children,
}: {
  x: number;
  y: number;
  onClose: () => void;
  role?: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 定位到坐标 + viewport clamp（首帧量真实尺寸再 clamp，visibility 先藏住）
  useLayoutEffect(() => {
    const m = ref.current;
    const h = m?.offsetHeight ?? 36;
    const w = m?.offsetWidth ?? 160;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = y;
    let left = x;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
    setPos({ top, left });
  }, [x, y]);

  // 关闭交互：outside click（mousedown）+ Esc + 滚动
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (target && ref.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
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

  return createPortal(
    <div
      ref={ref}
      role={role}
      style={{ top: pos?.top ?? 0, left: pos?.left ?? 0, visibility: pos ? 'visible' : 'hidden' }}
      className={cn(
        // 圆角 2px：脱离 token scale（最小档 xs=3px），PM 试看硬朗感的临时字面值
        'fixed z-50 min-w-[150px] overflow-hidden rounded-[2px] border border-border bg-elevated py-1 shadow-pop',
        className,
      )}
    >
      {children}
    </div>,
    document.body,
  );
}
