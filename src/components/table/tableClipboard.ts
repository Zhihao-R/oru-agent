/**
 * 表格剪贴板 —— 选区 ⇄ TSV 的坐标映射（纯函数，不碰剪贴板 API 也不碰 store）。
 *
 * 两套坐标必须分清：选区与落点用**显示序**（排序筛选后的行号，用户看到的），
 * 写入用**文件行号**。两者的换算表是 displayIdx，这个文件就是那道翻译层。
 */
import { parseTsv, serializeTsv } from '@shared/csv';
import { normalizeRange, type TableSelection } from '@/lib/tableSelection';

/** 选区 → TSV。读显示序，导出的顺序就是屏幕上的顺序。 */
export function selectionToTsv(rows: string[][], displayIdx: number[], sel: TableSelection): string {
  if (!sel) return '';
  if (sel.kind === 'col') return serializeTsv(displayIdx.map((i) => [rows[i]?.[sel.col] ?? '']));
  const { r1, c1, r2, c2 } = normalizeRange(sel);
  const out: string[][] = [];
  for (let r = r1; r <= r2; r++) {
    const fileRow = displayIdx[r];
    if (fileRow === undefined) continue;
    const line: string[] = [];
    for (let c = c1; c <= c2; c++) line.push(rows[fileRow]?.[c] ?? '');
    out.push(line);
  }
  return serializeTsv(out);
}

export type PasteTarget = {
  /** 目标文件行号（含扩表新增的行号，追加在文件末尾） */
  rows: number[];
  col: number;
  block: string[][];
  /** 因超出可见行而追加的新行数；筛选态下这些行当前看不见，需如实告知 */
  appended: number;
};

/**
 * TSV + 落点 → 写入参数。
 *
 * `topLeft` 是选区**左上角**而非拖拽锚点——反向框选时两者不等，传错会让粘贴落在对角线另一头。
 * `selSize` 只在「单值铺满」时参与计算：源就一格、选区大于一格，则按选区尺寸铺开。
 */
export function tsvToBlock(
  text: string,
  displayIdx: number[],
  rowCount: number,
  topLeft: { r: number; c: number },
  selSize: { rows: number; cols: number },
): PasteTarget | null {
  const parsed = parseTsv(text);
  if (parsed.length === 0) return null;

  const lone = parsed.length === 1 && parsed[0]?.length === 1 ? parsed[0][0] : null;
  const spread = lone !== null && (selSize.rows > 1 || selSize.cols > 1);
  const raw = spread
    ? Array.from({ length: selSize.rows }, () => Array.from({ length: selSize.cols }, () => lone))
    : parsed;

  // 补齐到最宽的一行：TSV 各行列数可以不等，而写入按统一宽度铺，不补会按首行宽度越界
  // reduce 而非展开：从 Excel 粘十万行进 Math.max(...) 会 RangeError
  const width = raw.reduce((m, r) => Math.max(m, r.length), 0);
  const block = raw.map((r) => (r.length === width ? r : [...r, ...Array.from({ length: width - r.length }, () => '')]));

  // 目标行：从落点起沿显示序取；显示序走完了就在文件末尾追加
  const rows: number[] = [];
  let appendAt = rowCount;
  for (let i = 0; i < block.length; i++) {
    const fileRow = displayIdx[topLeft.r + i];
    rows.push(fileRow ?? appendAt++);
  }

  return { rows, col: topLeft.c, block, appended: appendAt - rowCount };
}
