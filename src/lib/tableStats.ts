/**
 * 表格视图态纯函数 —— 统计条解析口径 + 排序/筛选的间接下标。
 *
 * 统计口径（PRD 场景二）：剥掉千分位逗号、货币符号、百分号后能解析为数的值参与
 * 求和/平均，空值跳过，混有文本时标注「已忽略 N 个非数字」——白领的金额列常态是
 * `¥1,234.56`，严格判数字会让最想看总数的列恰好看不了。
 *
 * 排序是纯视图态：rows 永远保持文件序，这里只产出显示用的间接下标。
 */

/** 宽松数字解析；解析不出返回 null。百分号按比值（15% → 0.15）。 */
export function parseNum(raw: string): number | null {
  let t = raw.trim();
  if (t === '') return null;
  t = t.replace(/^[¥￥$€£]\s*/, '');
  let percent = false;
  if (t.endsWith('%')) {
    percent = true;
    t = t.slice(0, -1).trim();
  }
  if (t.includes(',')) {
    // 千分位必须位置合法，否则不硬解析（"1,2,3" 是文本不是数）
    if (!/^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(t)) return null;
    t = t.replaceAll(',', '');
  }
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return percent ? n / 100 : n;
}

export type ColumnStats = {
  /** 非空值个数 */
  count: number;
  sum: number | null;
  avg: number | null;
  /** 非空但解析不为数的个数（sum 非 null 时展示「已忽略 N 个非数字」） */
  ignored: number;
};

export function computeStats(values: string[]): ColumnStats {
  const nonEmpty = values.filter((v) => v.trim() !== '');
  const nums = nonEmpty.map(parseNum).filter((n): n is number => n !== null);
  const ignored = nonEmpty.length - nums.length;
  if (nums.length === 0) return { count: nonEmpty.length, sum: null, avg: null, ignored };
  const sum = nums.reduce((a, b) => a + b, 0);
  return { count: nonEmpty.length, sum, avg: sum / nums.length, ignored };
}

export type SortState = { col: number; asc: boolean };

function compareCell(a: string, b: string): number {
  const na = parseNum(a);
  const nb = parseNum(b);
  if (na !== null && nb !== null) return na - nb;
  if (na !== null) return -1; // 数在文本前
  if (nb !== null) return 1;
  return a.localeCompare(b, 'zh-Hans-CN');
}

/** 筛选（多列叠加，列下标为 key、按值勾选）+ 排序（稳定，同值保持文件序）后的显示下标。 */
export function displayIndexes(
  rows: string[][],
  sort: SortState | null,
  filters: Map<number, Set<string>>,
): number[] {
  let idx = rows.map((_, i) => i);
  for (const [col, allowed] of filters) {
    idx = idx.filter((i) => allowed.has(rows[i]![col] ?? ''));
  }
  if (sort) {
    idx.sort((a, b) => {
      const d = compareCell(rows[a]![sort.col] ?? '', rows[b]![sort.col] ?? '');
      if (d !== 0) return sort.asc ? d : -d;
      return a - b; // 稳定：同值按文件序
    });
  }
  return idx;
}
