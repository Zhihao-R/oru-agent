/**
 * 左栏总容器（二态视图）
 * - 顶部：SidebarTabs（对话 / 文件）
 * - 「对话」视图：ConversationList（自带滚动）——不展示/切换项目
 * - 「文件」视图：ProjectIndicator（切换项目）+ DeckListPanel + FileTree；无活跃项目时显示新建按钮
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { ConversationList } from './ConversationList';
import { SidebarTabs } from './SidebarTabs';
import { ProjectIndicator } from './ProjectIndicator';
import { DeckListPanel } from './deck/DeckListPanel';
import { FileTree } from './FileTree';
import { AddProjectDialog } from './AddProjectDialog';
import { useLayoutStore } from '@/stores/layoutStore';
import { useProjectStore } from '@/stores/projectStore';

export function SidebarLeft() {
  const view = useLayoutStore((s) => s.sidebarView);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);

  return (
    // 背景（不透明 canvas 实色）是两态共享外观，收在此处单一事实源。右边分隔线不在此处：
    // 常驻态由相邻的 ResizeHandle（w-px bg-border）充当，自动隐藏浮层由其容器的 border-r 给——
    // 若这里也画 border-r，常驻态会和 ResizeHandle 叠成双线显粗。
    <div className="flex h-full flex-col bg-canvas">
      <SidebarTabs />
      {view === 'chat' ? (
        // ConversationList 自管布局：顶部「新对话/搜索」固定，下方列表/搜索结果自滚
        <div className="min-h-0 flex-1">
          <ConversationList />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <ProjectIndicator />
          {activeProjectId ? (
            <>
              <DeckListPanel emptyVariant="show" />
              <div className="min-h-0 flex-1">
                <FileTree projectId={activeProjectId} />
              </div>
            </>
          ) : (
            <ProjectEmptyState />
          )}
        </div>
      )}
    </div>
  );
}

/** 无活跃项目时的「项目」视图空态：直接给一个新建按钮 */
function ProjectEmptyState() {
  const { t } = useTranslation('app');
  const [addOpen, setAddOpen] = useState(false);
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <span className="text-xs text-text-tertiary">{t('noProjectSelected')}</span>
      <button
        type="button"
        onClick={() => setAddOpen(true)}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors hover:bg-hover hover:text-text-primary"
      >
        <Plus size={12} strokeWidth={1.5} />
        <span>{t('newProject')}</span>
      </button>
      <AddProjectDialog open={addOpen} onClose={() => setAddOpen(false)} />
    </div>
  );
}
