import { FloatingLayer } from '@/components/ui/FloatingLayer';
import { KindIcon } from '@/components/workspace/KindIcon';
import { MiddleTruncate } from '@/components/workspace/MiddleTruncate';
import { TabCloseButton } from '@/components/workspace/TabCloseButton';
import { tabSourcePath } from '@/components/workspace/tabSource';
import { parentDir } from '@/lib/paths';
import type { Tab } from '@/stores/workspaceStore';

/**
 * 标签栏溢出菜单：栏里放不下的标签在这里列全名 + 所在目录。
 *
 * 目录那行只在本次列表里出现重名时才补——同一批 mountain-gradient-*.png 目录全等、写出来是零信息，
 * 白占一行高度；真需要它的是三个 README.md 那种同名不同目录。位于项目根或解析不出路径的标签同样不补。
 *
 * 高度上限 360px ≈ 8 行两层行：常见规模一屏看完不用滚，再多才交给滚动。
 */
export function TabOverflowMenu({
  x,
  y,
  tabs,
  onPick,
  onCloseTab,
  onClose,
}: {
  x: number;
  y: number;
  tabs: Tab[];
  /** 激活该标签（调用方负责把它换进可见区）。 */
  onPick: (id: string) => void;
  onCloseTab: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const dupes = new Set(
    tabs.map((tb) => tb.title).filter((title, i, all) => all.indexOf(title) !== i),
  );
  return (
    <FloatingLayer
      x={x}
      y={y}
      onClose={onClose}
      role="menu"
      className="max-h-[360px] min-w-[220px] max-w-[340px] overflow-y-auto"
    >
      {tabs.map((tab) => {
        const dir = dupes.has(tab.title) ? parentDir(tabSourcePath(tab)?.path ?? '') : '';
        return (
          // 关闭 ✕ 绝对定位成兄弟而非嵌在行里——button 不能嵌 button，行本身得是 button 才有键盘可达。
          <div key={tab.id} className="group relative">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                onPick(tab.id);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 pr-8 text-left transition-colors hover:bg-hover"
            >
              <KindIcon kind={tab.kind} active={false} />
              <span className="min-w-0 flex-1">
                <span className="flex font-mono text-xs text-text-primary">
                  <MiddleTruncate text={tab.title} />
                </span>
                {dir && <span className="block truncate text-2xs text-text-quaternary">{dir}</span>}
              </span>
            </button>
            {/* 关一个不收菜单：这里正是「一次收拾掉几个」的地方，每关一次都要重开菜单太贵。
                关到溢出为空时由标签栏那边收起（它才知道还剩几个）。 */}
            <TabCloseButton
              title={tab.title}
              onClose={() => onCloseTab(tab.id)}
              className="invisible absolute right-2 top-1/2 -translate-y-1/2 group-hover:visible"
            />
          </div>
        );
      })}
    </FloatingLayer>
  );
}
