import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useArtifactStore } from '@/stores/artifactStore';
import { computeNewOrder } from '@/lib/reorderSlides';

/**
 * 底部大纲条（仅 deck profile）
 *
 * 一排横向编号格子，对应 deck 的每一页：
 * - 点格子 → 跳到该页（setCurrentPage）
 * - HTML5 native drag 拖动格子重排 → reorderSlides
 *
 * 右侧钉一组翻页控件（← N/M →）：与缩略图区用分隔线隔开，
 * 不参与横向滚动——页数再多也始终可见。缩略图区单独 overflow-x-auto，
 * 翻页时把高亮格横向滚回视野（只动缩略图容器 scrollLeft，不碰竖向/外层）。
 *
 * v1 只画编号格子不做真实缩略图——逐页截图太重，编号即可达成"重排 + 跳页"。
 * 二期可升级为真实缩略图（capturePage 每页一张缓存）。
 *
 * 横向拖拽落点 before/after 用 clientX 与目标格子中线比较：左半 = before，右半 = after。
 */
type Props = {
  artifactId: string;
};

export function OutlineStrip({ artifactId }: Props) {
  const { t } = useTranslation('deck');
  const slideCount = useArtifactStore((s) => s.deckMetaByArtifact[artifactId]?.slideCount ?? 0);
  const currentPageIndex = useArtifactStore((s) => s.currentPageIndexByArtifactId[artifactId] ?? 0);
  const setCurrentPage = useArtifactStore((s) => s.setCurrentPage);
  const reorderSlides = useArtifactStore((s) => s.reorderSlides);

  // 拖拽态：拖起的源页 + 当前落点（目标页 + 前/后）
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<{ index: number; pos: 'before' | 'after' } | null>(null);

  // 当前高亮格子：翻页（尤其用右侧箭头连点）时把它滚回视野，否则页数一多就翻到看不见的格子。
  // 只调整缩略图容器自身的 scrollLeft——不用 scrollIntoView，避免它顺祖先链把外层/窗口也竖向顶动。
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const activeCellRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    const cell = activeCellRef.current;
    const box = scrollRef.current;
    if (!cell || !box) return;
    const cellRect = cell.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    if (cellRect.left < boxRect.left) box.scrollLeft -= boxRect.left - cellRect.left + 6;
    else if (cellRect.right > boxRect.right) box.scrollLeft += cellRect.right - boxRect.right + 6;
  }, [currentPageIndex]);

  function endDrag() {
    setDragFrom(null);
    setDragOver(null);
  }

  if (slideCount === 0) return null;

  return (
    <div className="flex shrink-0 items-stretch border-t border-border bg-sunken-2">
      {/* 缩略图区：页数多时只滚这一段 */}
      <div ref={scrollRef} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-3 py-2">
        {Array.from({ length: slideCount }, (_, i) => {
          const isCurrent = i === currentPageIndex;
          const isDragging = dragFrom === i;
          const isOver = dragOver?.index === i;
          return (
            <button
              key={i}
              ref={isCurrent ? activeCellRef : undefined}
              type="button"
              draggable
              onClick={() => setCurrentPage(artifactId, i)}
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = 'move';
                // 必须 setData 否则 Firefox 不会真启动 drag
                e.dataTransfer.setData('text/plain', String(i));
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault(); // 必须 preventDefault 才允许 drop
                e.dataTransfer.dropEffect = 'move';
                const rect = e.currentTarget.getBoundingClientRect();
                const pos: 'before' | 'after' =
                  e.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                setDragOver((cur) =>
                  cur?.index === i && cur.pos === pos ? cur : { index: i, pos },
                );
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom === null || dragOver === null) {
                  endDrag();
                  return;
                }
                const newOrder = computeNewOrder(slideCount, dragFrom, dragOver.index, dragOver.pos);
                endDrag();
                if (newOrder !== null) {
                  void reorderSlides(artifactId, newOrder);
                  // 重排后让"当前页"跟随用户原本在看的那一页内容（newOrder[newPos]=oldIndex），
                  // 否则 currentPageIndex 停在旧位置 → 高亮/预览悄悄换成别页内容
                  const newCurrent = newOrder.indexOf(currentPageIndex);
                  if (newCurrent !== -1) setCurrentPage(artifactId, newCurrent);
                }
              }}
              onDragEnd={endDrag}
              title={t('outline.pageTitle', { n: i + 1 })}
              className={`relative flex h-9 w-11 shrink-0 cursor-grab items-center justify-center rounded border text-xs tabular-nums transition-colors active:cursor-grabbing ${
                isDragging
                  ? 'opacity-40'
                  : isCurrent
                    ? 'border-accent bg-accent-soft text-accent'
                    : 'border-border bg-canvas text-text-secondary hover:border-accent hover:text-text-primary'
              }`}
            >
              {/* drop 指示线：2px accent 竖线在目标格子左/右边 */}
              {isOver && dragOver?.pos === 'before' && (
                <span aria-hidden className="pointer-events-none absolute inset-y-0 -left-1 w-0.5 rounded bg-accent" />
              )}
              {isOver && dragOver?.pos === 'after' && (
                <span aria-hidden className="pointer-events-none absolute inset-y-0 -right-1 w-0.5 rounded bg-accent" />
              )}
              {i + 1}
            </button>
          );
        })}
      </div>

      {/* 翻页控件：钉右侧、不滚动，左分隔线与缩略图区隔开 */}
      <div className="flex shrink-0 items-center gap-1 border-l border-border px-3">
        <button
          type="button"
          onClick={() => setCurrentPage(artifactId, currentPageIndex - 1)}
          disabled={currentPageIndex <= 0}
          title={t('outline.prevPage')}
          className="flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
        >
          <ChevronLeft size={14} strokeWidth={1.8} />
        </button>
        <span className="min-w-[3em] text-center text-xs tabular-nums text-text-secondary">
          {currentPageIndex + 1}/{slideCount}
        </span>
        <button
          type="button"
          onClick={() => setCurrentPage(artifactId, currentPageIndex + 1)}
          disabled={currentPageIndex >= slideCount - 1}
          title={t('outline.nextPage')}
          className="flex h-6 w-6 items-center justify-center rounded text-text-secondary hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-text-secondary"
        >
          <ChevronRight size={14} strokeWidth={1.8} />
        </button>
      </div>
    </div>
  );
}
