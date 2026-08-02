/**
 * 左栏 Deck 栏：列出当前 active project 的所有 decks
 *
 * - 点击行 = 开成 deck 标签（已开则切过去，§3.2）；点 active 行的 ✕ = 关掉该 deck 标签
 * - active 行（= 活跃标签是这个 deck）用 bg-accent-soft 标记 + icon 染 accent
 * - emptyVariant='hide'：空时整段不渲染（默认，原行为）
 * - emptyVariant='show'：空时显示标题 + onboarding 提示（「项目」视图用）
 */
import { useTranslation } from 'react-i18next';
import { Layers, X } from 'lucide-react';
import type { ArtifactRecord } from '@shared/types';
import { cn } from '@/lib/cn';
import { useArtifactStore, useActiveArtifactId } from '@/stores/artifactStore';
import { useProjectStore } from '@/stores/projectStore';
import { useWorkspaceStore, makeTab } from '@/stores/workspaceStore';

// 稳定空数组：避免 selector fallback `?? []` 触发无限渲染
const EMPTY_DECKS: ArtifactRecord[] = [];

type DeckListPanelProps = {
  emptyVariant?: 'hide' | 'show';
};

export function DeckListPanel({ emptyVariant = 'hide' }: DeckListPanelProps = {}) {
  const { t } = useTranslation('deck');
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const decks = useArtifactStore((s) =>
    activeProjectId ? s.artifactsByProject[activeProjectId] ?? EMPTY_DECKS : EMPTY_DECKS,
  );
  const activeArtifactId = useActiveArtifactId();
  const openTab = useWorkspaceStore((s) => s.openTab);
  const closeTab = useWorkspaceStore((s) => s.closeTab);

  if (decks.length === 0 && emptyVariant === 'hide') return null;

  return (
    <div className="flex shrink-0 flex-col px-2 pb-2 pt-3">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-medium uppercase tracking-wider text-text-tertiary">
          {t('list.heading')}
        </span>
        <span className="text-xs text-text-tertiary">{decks.length}</span>
      </div>
      {decks.length === 0 ? (
        <div className="px-2 py-2 text-xs text-text-tertiary">
          {t('list.empty')}
        </div>
      ) : (
        <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
          {decks.map((d) => {
            const isActive = d.id === activeArtifactId;
            return (
              <div
                key={d.id}
                className={cn(
                  'flex h-7 items-center rounded-sm pl-2 pr-1 text-sm transition-colors',
                  isActive ? 'bg-accent-soft text-text-primary' : 'text-text-secondary hover:bg-hover',
                )}
              >
                <button
                  type="button"
                  onClick={() => openTab(makeTab({ kind: 'deck', projectId: d.projectId, ref: d.id, title: d.name }))}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <Layers
                    size={12}
                    strokeWidth={1.5}
                    className={cn('shrink-0', isActive ? 'text-accent' : 'text-text-tertiary')}
                  />
                  <span className="min-w-0 flex-1 truncate">{d.name}</span>
                </button>
                {isActive ? (
                  <button
                    type="button"
                    onClick={() => closeTab(`deck:${d.id}`)}
                    title={t('list.closeTitle')}
                    className="ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-hover hover:text-danger"
                  >
                    <X size={11} strokeWidth={1.6} />
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
