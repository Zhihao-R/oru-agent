import type { LucideIcon } from 'lucide-react';
import { FloatingLayer } from '@/components/ui/FloatingLayer';

export type MenuItem = { key: string; label: string; icon: LucideIcon; onClick: () => void };
export type MenuRow = MenuItem | { key: string; separator: true };

/**
 * 右键菜单：锚到鼠标坐标弹出一组动作项，文件树、文件标签共用。定位 / 关闭 / portal
 * 收在 FloatingLayer 浮层壳里（与工具条下拉共用），本组件只攒 rows。
 */
export function ContextMenu({
  x,
  y,
  rows,
  onClose,
}: {
  x: number;
  y: number;
  rows: MenuRow[];
  onClose: () => void;
}): JSX.Element {
  return (
    <FloatingLayer x={x} y={y} onClose={onClose} role="menu">
      {rows.map((row) =>
        'separator' in row ? (
          <div key={row.key} role="separator" className="my-1 h-px bg-border" />
        ) : (
          <button
            key={row.key}
            type="button"
            role="menuitem"
            onClick={() => {
              onClose();
              row.onClick();
            }}
            className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs text-text-primary transition-colors hover:bg-hover"
          >
            <row.icon className="h-3.5 w-3.5 shrink-0 text-text-tertiary" strokeWidth={1.5} />
            <span>{row.label}</span>
          </button>
        ),
      )}
    </FloatingLayer>
  );
}
