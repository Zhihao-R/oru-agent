/**
 * 左栏顶部一行：「对话 / 文件」分段 tab（icon + 文字，sunken 容器占满行宽、两段均分）
 * + 右端收起按钮（常驻模式才有——autoHide 是浮层，无收起概念）。
 * 搜索 / 新对话入口在 ConversationList 顶行（对话视图专属，不属于 tab 行）。
 * 内部 id 仍是 'chat'|'project'（数据哨兵，不随标签文案改）；「文件」视图承载项目指示器 + 文件树，
 * 对话视图不显示项目上下文（2026-07-19 骨-2）。
 *
 * 选中态＝`--segment-on` 实底 + `--segment-on-fg`（2026-07-27 PM 拍板，全站四处分段控件一致，
 * 见设计词汇表「选中 · 分段控件」行）。改动起因：原先的「轨道下沉 + 选中抬起成白」在带色纸面
 * （雪线主题把 bg-sunken 染紫）上读作挖空的洞，谁是选中态要想一下。
 *
 * 为什么走 token 而不是直接 `bg-accent`：轨道本身带色的主题里，accent 实底与轨道会变成两支彩色
 * 对撞——雪线因此把 `--segment-on` 改写成与轨道同族的深紫。token 默认值是 `var(--accent)`，
 * 其余六套零配置；第二套要改也只是在自己的日夜块里各加两行。
 *
 * 已知代价：默认值与主操作按钮（发送）同形态、两种含义——PM 已知情并选择了这一版；
 * 若日后要回收这个形态，改 `:root` 的默认值一处即可，不必动组件。
 * 对照 demo：docs/superpowers/mockups/2026-07-27-分段tab选中态-对照.html
 */
import { useTranslation } from 'react-i18next';
import { ChevronsLeft, Folder, MessageSquare, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useLayoutStore, type SidebarView } from '@/stores/layoutStore';

const TABS: ReadonlyArray<{ id: SidebarView; Icon: LucideIcon }> = [
  { id: 'chat', Icon: MessageSquare },
  { id: 'project', Icon: Folder },
];

export function SidebarTabs() {
  const { t } = useTranslation('app');
  const view = useLayoutStore((s) => s.sidebarView);
  const setView = useLayoutStore((s) => s.setSidebarView);
  const autoHide = useLayoutStore((s) => s.autoHideSidebar);
  const toggleCollapsed = useLayoutStore((s) => s.toggleSidebarCollapsed);
  return (
    <div className="px-2.5 pt-2">
      {/* 一体化胶囊：两个 tab 均分 + 收起按钮同住 sunken 容器（收起是对这组视图整体的操作） */}
      <span className="flex w-full items-stretch gap-0.5 rounded-md bg-sunken p-0.5">
        {TABS.map(({ id, Icon }) => {
          const active = view === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-sm px-3 py-1 text-xs font-medium transition-colors',
                active
                  ? 'bg-[var(--segment-on)] text-[var(--segment-on-fg)]'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <Icon size={13} strokeWidth={1.75} />
              {t(`tab.${id}`)}
            </button>
          );
        })}
        {!autoHide ? (
          <button
            type="button"
            onClick={toggleCollapsed}
            title={t('collapseSidebar')}
            aria-label={t('collapseSidebar')}
            className="flex shrink-0 items-center justify-center rounded-sm px-1.5 text-text-tertiary transition-colors hover:text-text-primary"
          >
            <ChevronsLeft size={13} strokeWidth={1.75} />
          </button>
        ) : null}
      </span>
    </div>
  );
}
