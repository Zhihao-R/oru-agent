import { forwardRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, Copy, FolderSearch, type LucideIcon } from 'lucide-react';
import { ContextMenu } from '@/components/ui/ContextMenu';
import { FloatingLayer } from '@/components/ui/FloatingLayer';
import { useFsStore } from '@/stores/fsStore';
import { cn } from '@/lib/cn';

/**
 * 双行壳的第二行——壳级 40px 工具条行（设计稿 1a–1d 统一结构）。
 *
 * 五个查看器同构：左 = 文件路径面包屑（mono + ▾，点开走路径动作菜单），右 = 操作钮组
 * （通用工具图标化 28px + title，核心动作带文字置最右）。标签行（44px）归 TabBar，
 * 只放标签；本行承载路径与操作，把原先散在各查看器内部的历史/导出/刷新等上提于此。
 *
 * `leading` 落在面包屑之前（deck 的预览/文稿 tab、html 的改前/改后段这类随视图切换的前置件）。
 * `children` 是右侧操作钮，用下方 Toolbar* 原语拼，保证五查看器操作钮完全同构。
 */
export function ViewerToolbar({
  path,
  leading,
  children,
}: {
  path: string;
  leading?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex h-10 shrink-0 items-center gap-3 border-b border-border bg-elevated px-3.5">
      {leading}
      <PathBreadcrumb path={path} />
      <span className="flex-1" />
      <div className="flex shrink-0 items-center gap-1">{children}</div>
    </div>
  );
}

/** 路径面包屑（mono + ▾）：点击弹「复制路径 / 在访达中显示」两项路径动作（复用 files ns 与 fsStore）。 */
function PathBreadcrumb({ path }: { path: string }): JSX.Element {
  const { t } = useTranslation('files');
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  return (
    <>
      <button
        type="button"
        title={path}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu(menu ? null : { x: r.left, y: r.bottom + 4 });
        }}
        className="inline-flex min-w-0 items-center gap-1.5 font-mono text-sm text-text-secondary transition-colors hover:text-text-primary"
      >
        <span className="truncate">{path}</span>
        <ChevronDown className="h-2.5 w-2.5 shrink-0 text-text-quaternary" strokeWidth={1.6} />
      </button>
      {menu ? (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          rows={[
            { key: 'copy-path', label: t('menu.copyPath'), icon: Copy, onClick: () => void navigator.clipboard.writeText(path) },
            { key: 'reveal', label: t('menu.reveal'), icon: FolderSearch, onClick: () => void useFsStore.getState().reveal(path) },
          ]}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </>
  );
}

/** 工具条通用图标钮（28px，hover 抬到 sunken 底 + 主文字色）——五查看器所有图标操作共用。 */
export const ToolbarIconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ToolbarIconButton({ className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded text-text-tertiary transition-colors hover:bg-sunken hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
          className,
        )}
      >
        {children}
      </button>
    );
  },
);

/** 工具条文字操作钮（28px，核心动作带文字，置于最右）。 */
export const ToolbarTextButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement>>(
  function ToolbarTextButton({ className, children, ...rest }, ref) {
    return (
      <button
        ref={ref}
        type="button"
        {...rest}
        className={cn(
          'flex h-7 items-center gap-1.5 rounded px-2.5 text-base text-text-secondary transition-colors hover:bg-sunken hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
          className,
        )}
      >
        {children}
      </button>
    );
  },
);

/** 工具条分组竖分隔线（把通用工具与核心动作分组）。 */
export function ToolbarDivider(): JSX.Element {
  return <span className="mx-1 h-4 w-px shrink-0 bg-border-strong" />;
}

/**
 * 工具条分段切换（随视图切换的前置件，走 leading）——网页与演示稿的「改前/改后」共用一套视觉。
 * 选中态＝`--segment-on` 实底（默认回落 accent；雪线改写成同族深紫），全站四处分段控件一致，
 * 见设计词汇表「选中 · 分段控件」行与 SidebarTabs 的成因注释。加第三处分段零成本。
 */
export function ToolbarSegmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-px rounded-md border border-border bg-sunken p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-5 rounded px-2.5 text-xs transition-colors',
            value === o.value ? 'bg-[var(--segment-on)] text-[var(--segment-on-fg)]' : 'text-text-secondary hover:text-text-primary',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 工具条下拉选择（图标 + 当前项 + ▾，点开列出全部、当前项打勾高亮）——
 * 离散单选偏好项 ≥3 且不需一眼横向对比时，比平铺分段更克制。加第二处零成本。
 * 当 value 不落在任何 option 上（如表格拖拽出的中间行高），trigger 回落 `fallbackLabel`
 * ——它是一个真实态（「自定义」值确实生效了），非空占位，故不叫 placeholder。
 */
export function ToolbarSelect<T extends string>({
  icon: Icon,
  options,
  value,
  onChange,
  title,
  fallbackLabel,
}: {
  icon: LucideIcon;
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  title?: string;
  fallbackLabel?: string;
}): JSX.Element {
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <button
        type="button"
        title={title}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAnchor(anchor ? null : { x: r.left, y: r.bottom + 4 });
        }}
        // 次要选择器：字号弱一档（text-xs，与弹层项及原分段控件一致），不与核心动作钮（ToolbarTextButton, text-base）抢层级
        className="flex h-7 items-center gap-1.5 rounded px-2.5 text-xs text-text-secondary transition-colors hover:bg-sunken hover:text-text-primary"
      >
        <Icon className="h-[13px] w-[13px] shrink-0" strokeWidth={1.5} />
        <span>{current?.label ?? fallbackLabel}</span>
      </button>
      {anchor ? (
        <SelectPopover
          x={anchor.x}
          y={anchor.y}
          options={options}
          value={value}
          onSelect={(v) => {
            setAnchor(null);
            onChange(v);
          }}
          onClose={() => setAnchor(null)}
        />
      ) : null}
    </>
  );
}

/** ToolbarSelect 的弹层：复用 FloatingLayer 浮层壳（定位/关闭/portal），本体只列选项、当前项打勾。 */
function SelectPopover<T extends string>({
  x,
  y,
  options,
  value,
  onSelect,
  onClose,
}: {
  x: number;
  y: number;
  options: readonly { value: T; label: string; title?: string }[];
  value: T;
  onSelect: (v: T) => void;
  onClose: () => void;
}): JSX.Element {
  // 覆盖壳默认宽度：选项都是短词，150px 太空
  return (
    <FloatingLayer x={x} y={y} onClose={onClose} role="listbox" className="min-w-[92px]">
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="option"
            aria-selected={selected}
            title={o.title}
            onClick={() => onSelect(o.value)}
            className={cn(
              'flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors hover:bg-hover',
              selected ? 'text-text-primary' : 'text-text-secondary',
            )}
          >
            <Check
              className={cn('h-3 w-3 shrink-0', selected ? 'text-accent' : 'text-transparent')}
              strokeWidth={1.5}
            />
            <span>{o.label}</span>
          </button>
        );
      })}
    </FloatingLayer>
  );
}
