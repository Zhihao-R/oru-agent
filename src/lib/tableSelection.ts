/**
 * 表格选区的几何 —— 类型 + 归一化 + 命中判定 + 区域统计（纯函数，不碰 React 也不碰 store）。
 *
 * 选区存的是**锚点 + 焦点**（r1c1 = 拖拽起点，r2c2 = 当前端点），不是规范化好的矩形：
 * Shift+方向扩选必须知道从哪一端扩，存进去就规范化会把方向信息抹掉。
 *
 * 代价是每个消费者都得先归一化，所以收敛到 `normalizeRange` 一处——命中判定、区域统计、
 * 键盘扩选、复制范围、粘贴落点、查找跳转都调它。**禁止各自裸写 Math.min/max**：
 * 那是把「一处规范化」换成「六处各自规范化」，同一个问题两种解法。
 */
import { computeStats, type ColumnStats } from '@/lib/tableStats';

export type TableSelection =
  | { kind: 'col'; col: number }
  | { kind: 'range'; r1: number; c1: number; r2: number; c2: number }
  | null;

export type NormalizedRange = { r1: number; c1: number; r2: number; c2: number };

/** 锚点/焦点 → 左上/右下。全仓唯一的选区归一化入口。 */
export function normalizeRange(sel: NormalizedRange): NormalizedRange {
  return {
    r1: Math.min(sel.r1, sel.r2),
    c1: Math.min(sel.c1, sel.c2),
    r2: Math.max(sel.r1, sel.r2),
    c2: Math.max(sel.c1, sel.c2),
  };
}

/** displayRow 是**显示序**（排序筛选后的行号），与渲染循环的下标同源。 */
export function isCellSelected(selection: TableSelection, displayRow: number, col: number): boolean {
  if (!selection) return false;
  if (selection.kind === 'col') return selection.col === col;
  const { r1, c1, r2, c2 } = normalizeRange(selection);
  return displayRow >= r1 && displayRow <= r2 && col >= c1 && col <= c2;
}

export function computeStatsForSelection(
  rows: string[][],
  displayIdx: number[],
  selection: TableSelection,
): ColumnStats | null {
  if (!selection) return null;
  if (selection.kind === 'col') {
    // 列统计对筛选后的可见行算——筛出华东就是华东的合计，这正是筛选的本意
    return computeStats(displayIdx.map((i) => rows[i]?.[selection.col] ?? ''));
  }
  const { r1, c1, r2, c2 } = normalizeRange(selection);
  const values: string[] = [];
  for (let r = r1; r <= r2; r++) {
    const fileRow = displayIdx[r];
    if (fileRow === undefined) continue;
    for (let c = c1; c <= c2; c++) values.push(rows[fileRow]?.[c] ?? '');
  }
  return computeStats(values);
}
