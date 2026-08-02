import { useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronsRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useWorkspaceStore, type Tab } from '@/stores/workspaceStore';
import { tabSourcePath } from './tabSource';
import { setFileDragData } from '@/lib/fileDrag';
import { TabContextMenu } from './TabContextMenu';
import { TabOverflowMenu } from './TabOverflowMenu';
import { TabCloseButton } from './TabCloseButton';
import { MiddleTruncate } from './MiddleTruncate';
import { KindIcon } from './KindIcon';
import { layoutTabs, OVERFLOW_BTN_WIDTH } from './tabLayout';

/**
 * 右栏标签栏（tech design §3.2 / PRD §一）——打开的文件常驻成一组可切的标签。
 * 视觉与 Oru 一脉相承：复用既有 token（accent / sunken / hover / border / danger）、lucide 图标、
 * 关闭 ✕ 走仓库既有 hover 显形惯例（同 ConversationList）。
 *
 * 文件一多不再横向滚动：标签互相让位压到还认得出名字为止（layoutTabs），压不下的收进右端溢出菜单。
 */
export function TabBar(): JSX.Element {
  const { t } = useTranslation('app');
  const openTabs = useWorkspaceStore((s) => s.openTabs);
  const activeTabId = useWorkspaceStore((s) => s.activeTabId);
  const activateTab = useWorkspaceStore((s) => s.activateTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);
  const [menu, setMenu] = useState<{ x: number; y: number; source: { path: string; name: string } } | null>(null);
  const [overflowAt, setOverflowAt] = useState<{ x: number; y: number } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  // null = 还没量到：先当无限宽（都是满宽、无溢出）渲染，useLayoutEffect 在首帧绘制前改正，避免闪一下窄标签。
  const [barWidth, setBarWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBarWidth(el.clientWidth));
    ro.observe(el);
    setBarWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  const activeIndex = openTabs.findIndex((tb) => tb.id === activeTabId);
  const layout = layoutTabs(barWidth ?? Infinity, openTabs.length, activeIndex);
  const overflowTabs = layout.overflow.map((i) => openTabs[i]);

  // 溢出菜单开着时标签集合可能变（关标签 / Oru 开新文件）：溢出空了菜单自行退场，
  // 否则残留的坐标会在下次溢出时把菜单弹回旧位置。
  useEffect(() => {
    if (overflowTabs.length === 0) setOverflowAt(null);
  }, [overflowTabs.length]);

  // 右键 / 拖拽都经 tabSourcePath 把标签解析成磁盘路径；解析不出（deck 记录未到）则静默不响应。
  function onTabContextMenu(e: MouseEvent, tab: Tab): void {
    const source = tabSourcePath(tab);
    if (!source) return;
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, source });
  }

  function onTabDragStart(e: DragEvent, tab: Tab): void {
    const source = tabSourcePath(tab);
    if (!source) {
      e.preventDefault();
      return;
    }
    setFileDragData(e, { paths: [source.path], path: source.path, name: source.name });
    e.dataTransfer.effectAllowed = 'copy';
  }

  return (
    // 双行壳第一行：44px 纯标签行——只放标签，与对话标题行同高、横向分割线连续；底色实心 sunken-2。
    <div
      ref={barRef}
      className="flex h-11 shrink-0 items-stretch overflow-hidden border-b border-border bg-sunken-2"
    >
      {layout.visible.map((i) => {
        const tab = openTabs[i];
        const active = tab.id === activeTabId;
        return (
          <div
            key={tab.id}
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            draggable
            onDragStart={(e) => onTabDragStart(e, tab)}
            onContextMenu={(e) => onTabContextMenu(e, tab)}
            onClick={() => activateTab(tab.id)}
            title={tab.ref}
            style={{ width: layout.width }}
            className={cn(
              // 活跃态：抬到 elevated 白底 + 顶部 accent 竖标（inset 上边）+ 主文字色；非活跃透明底透出 sunken-2。
              'group relative flex shrink-0 cursor-pointer select-none items-center gap-1.5 overflow-hidden border-r border-border pl-[11px] pr-2 font-mono text-sm',
              active
                ? 'bg-elevated text-text-primary shadow-[inset_0_2px_0_var(--accent)]'
                : 'text-text-tertiary hover:bg-hover',
            )}
          >
            <KindIcon kind={tab.kind} active={active} />
            <MiddleTruncate text={tab.title} />
            {/* ✕ 不占位：绝对定位盖在名字尾巴上，hover 才现身。常年隐形却占着的 18px 在压缩档
                能吃掉近四成名字预算；鼠标要点它总得先 hover 到标签上，常显换不来可达性。
                遮盖底必须是实色 token——bg-hover 是 4% 的叠加色，拿它当底文字会直接透出来。
                自身 hover 反馈同理不能用 bg-hover（叠在同色底上几乎无变化），走深一档的 sunken。
                图标也从最弱的 quaternary 提到 tertiary：它没有独立位置，弱到极致就等于不存在。 */}
            <TabCloseButton
              title={tab.title}
              onClose={() => closeTab(tab.id)}
              className={cn(
                'invisible absolute right-1.5 top-1/2 -translate-y-1/2 group-hover:visible',
                'text-text-tertiary hover:bg-sunken hover:text-text-primary',
                active ? 'bg-elevated' : 'bg-sunken-2',
              )}
            />
          </div>
        );
      })}
      {overflowTabs.length > 0 && (
        <button
          type="button"
          aria-label={t('tabOverflow', { count: overflowTabs.length })}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setOverflowAt({ x: r.left, y: r.bottom });
          }}
          style={{ width: OVERFLOW_BTN_WIDTH }}
          className="flex shrink-0 items-center justify-center gap-0.5 text-xs text-text-tertiary hover:bg-hover hover:text-text-secondary"
        >
          <ChevronsRight className="h-3 w-3 shrink-0" strokeWidth={1.5} />
          {overflowTabs.length}
        </button>
      )}
      {menu && (
        <TabContextMenu x={menu.x} y={menu.y} source={menu.source} onClose={() => setMenu(null)} />
      )}
      {overflowAt && overflowTabs.length > 0 && (
        <TabOverflowMenu
          x={overflowAt.x}
          y={overflowAt.y}
          tabs={overflowTabs}
          onPick={activateTab}
          onCloseTab={closeTab}
          onClose={() => setOverflowAt(null)}
        />
      )}
    </div>
  );
}
