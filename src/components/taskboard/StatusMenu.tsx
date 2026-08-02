/**
 * 状态切换 Popover：4 个状态选项，当前态高亮。
 *
 * - 定位：anchorRef.getBoundingClientRect() 后用 fixed + top/left 锚到正下方
 * - 关闭：outside click（不含 anchor 自身——anchor 的 onClick 自己 toggle）+ Escape
 * - 点选：wsClient.request taskboard.update；不等响应，store 收到 broadcast 自动同步
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RefObject } from 'react';
import type { BoardTaskStatus } from '@shared/types';
import { wsClient } from '@/lib/ws';
import { toastError } from '@/lib/toast';
import { cn } from '@/lib/cn';
import { StatusBadge } from './StatusBadge';
import { statusLabel } from './statusLabel';

const ALL_STATUSES: BoardTaskStatus[] = ['待办', '进行中', '待验收', '已完成'];

export type StatusMenuProps = {
  taskId: string;
  currentStatus: BoardTaskStatus;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
};

export function StatusMenu({ taskId, currentStatus, anchorRef, onClose }: StatusMenuProps) {
  const { t } = useTranslation('taskboard');
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // 定位：每次挂载 + 滚动 / resize 时重算；带 viewport clamp 避免溢出
  // （4 个状态项 ≈ 32px * 4 + py-1 * 2 + border ≈ 138px；fallback 用这个估值）
  useLayoutEffect(() => {
    const compute = () => {
      const a = anchorRef.current;
      if (!a) return;
      const rect = a.getBoundingClientRect();
      const m = menuRef.current;
      const h = m?.offsetHeight ?? 138;
      const w = m?.offsetWidth ?? 140;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = rect.bottom + 4;
      let left = rect.left;
      // 底部溢出 → 翻到锚点上方
      if (top + h > vh - 8) top = Math.max(8, rect.top - h - 4);
      // 右侧溢出 → 收边
      if (left + w > vw - 8) left = Math.max(8, vw - w - 8);
      if (left < 8) left = 8;
      setPos({ top, left });
    };
    compute();
    // 第二帧再量真实高度，避免首帧 fallback 高度导致 clamp 翻转误判
    const raf = requestAnimationFrame(compute);
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [anchorRef]);

  // 关闭交互
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (menuRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return; // anchor 自己 toggle
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 阻止冒泡到 TaskboardMainView 的全局 Esc——否则关 popover 同时也会关详情面板
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchorRef, onClose]);

  const onSelect = (status: BoardTaskStatus) => {
    onClose();
    if (status === currentStatus) return;
    void wsClient
      .request({ type: 'taskboard.update', id: taskId, patch: { status } })
      .catch((err) => {
        console.warn('[taskboard] 切换状态失败:', err);
        toastError(t('toast.statusFailed'));
      });
  };

  // 首帧 visibility:hidden 渲染，让 menuRef.offsetHeight 在第二帧 rAF compute 时能量到真实尺寸
  return (
    <div
      ref={menuRef}
      role="menu"
      style={{
        top: pos?.top ?? 0,
        left: pos?.left ?? 0,
        visibility: pos ? 'visible' : 'hidden',
      }}
      className="fixed z-50 min-w-[140px] overflow-hidden rounded-md border border-border bg-elevated py-1 shadow-pop"
      onClick={(e) => e.stopPropagation()}
    >
      {ALL_STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onSelect(s)}
          className={cn(
            'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors hover:bg-hover',
            s === currentStatus && 'bg-hover/60',
          )}
        >
          <StatusBadge status={s} size={14} />
          <span className="text-text-primary">{statusLabel(s, t)}</span>
        </button>
      ))}
    </div>
  );
}
