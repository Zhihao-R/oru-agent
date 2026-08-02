/**
 * 表格查找 —— 命中定位与全量替换的纯计算（不碰 React 也不碰 store）。
 *
 * 命中**按屏幕顺序产出**（遍历 displayIdx，所以跳转顺序就是肉眼扫读的顺序），
 * 但坐标**存文件行号**。这样「只看命中行」过滤 displayIdx 之后命中集合不用重算——
 * 若存显示序，displayIdx 一变坐标就全错位，而 displayIdx 又依赖命中集合，两者会互相咬住。
 *
 * 表头参与匹配（「哪一列叫销售额」是真实需求），用 fileRow = -1 标记。
 */

/** fileRow = HEADER_ROW 表示命中在表头 */
export type SearchHit = { fileRow: number; col: number };

export const HEADER_ROW = -1;

/** 命中格的查找键（渲染时按格判断要不要描边）。 */
export const hitKey = (fileRow: number, col: number): string => `${fileRow}:${col}`;

/** 匹配不分大小写；顺序是表头 → 屏幕上从上到下 → 从左到右。 */
export function findHits(headers: string[], rows: string[][], displayIdx: number[], query: string): SearchHit[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  const hits: SearchHit[] = [];
  headers.forEach((h, c) => {
    if (h.toLowerCase().includes(needle)) hits.push({ fileRow: HEADER_ROW, col: c });
  });
  // 只扫**渲染得出来的**列：数据行的字段数可能多于表头（参差 CSV 合法），
  // 扫过界会数出用户找不到的命中，替换时还会把包围盒撑过表宽、给整表凭空加列。
  for (const fileRow of displayIdx) {
    const row = rows[fileRow];
    if (!row) continue;
    const limit = Math.min(row.length, headers.length);
    for (let c = 0; c < limit; c++) {
      if ((row[c] ?? '').toLowerCase().includes(needle)) hits.push({ fileRow, col: c });
    }
  }
  return hits;
}

/** 命中所在的文件行（去重，保持屏幕顺序，不含表头）——「只看命中行」拿它再过滤一层 displayIdx。 */
export function hitFileRows(hits: SearchHit[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const h of hits) {
    if (h.fileRow === HEADER_ROW || seen.has(h.fileRow)) continue;
    seen.add(h.fileRow);
    out.push(h.fileRow);
  }
  return out;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 全量替换 → 一个 block op 的写入参数（整块一次撤销）。
 *
 * 命中格是离散分布的，而 block 是矩形——**行方向精确**（rows 是数组，只收命中行，
 * 中间没命中的行不进来），**列方向取包围盒**（列最多几十个，冗余有限）。
 * 包围盒内未命中的格子原值进 next，写回去等于没动。
 *
 * 表头命中不参与替换：block op 不写表头，且改表头是改结构，双击表头直接改更直接。
 *
 * 替换一次成型不迭代——`a → aa` 若边替边重扫会无限展开。
 */
export function replaceAllTarget(
  hits: SearchHit[],
  rows: string[][],
  query: string,
  replacement: string,
): { rows: number[]; col: number; block: string[][] } | null {
  const dataHits = hits.filter((h) => h.fileRow !== HEADER_ROW);
  if (!query || dataHits.length === 0) return null;

  const targetRows = hitFileRows(dataHits);
  // reduce 而非展开：命中数是行×列，十万行表可轻易到几十万，展开进 Math.min/max 会栈溢出
  const c1 = dataHits.reduce((m, h) => Math.min(m, h.col), Infinity);
  const c2 = dataHits.reduce((m, h) => Math.max(m, h.col), 0);
  const re = new RegExp(escapeRe(query), 'gi');
  const safe = replacement.replace(/\$/g, '$$$$'); // 替换串里的 $ 是字面量，不是 $& 那类模式

  const block = targetRows.map((fileRow) => {
    const line: string[] = [];
    for (let c = c1; c <= c2; c++) line.push((rows[fileRow]?.[c] ?? '').replace(re, safe));
    return line;
  });
  return { rows: targetRows, col: c1, block };
}
