/**
 * xlsx → CSV 纯转换（不落盘，落盘与冲突判定在 importXlsx 编排层）。
 *
 * 确定性是承重承诺：同一 xlsx 字节输入必得同一 CSV 字节输出——单元格规则定死、
 * 无时间戳无随机量、sheet 按 workbook 物理顺序、日期用 UTC 分量格式化（不受本机时区影响）。
 * 导入的 diff 冲突判定（"未改过的 CSV 重拖必须静默刷新"）建立在这之上。
 *
 * 边界（tech design）：xlsx 里已存成数字格的超长编号源头精度已丢（Excel 双精度 15 位），
 * 这里保证"文本格不丢 + 数字格不变科学计数法"，不承诺找回源头丢失的精度。
 */
import ExcelJS from 'exceljs';
import { serializeCsv } from '@shared/csv';

export type ConvertedSheet = { name: string; csv: string };

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** 日期 → `2026-04-03`；带时间分量补 ` HH:mm:ss`。UTC 取值（exceljs 的序列号↔Date 换算同基）。 */
function formatDate(d: Date): string {
  const date = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const s = d.getUTCSeconds();
  if (h === 0 && m === 0 && s === 0) return date;
  return `${date} ${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** 数字 → 十进制字符串，禁科学计数法（超界手工展开）。 */
export function numberToDecimalString(n: number): string {
  const s = String(n);
  if (!/[eE]/.test(s)) return s;
  const [mantissaRaw, expRaw] = s.split(/[eE]/) as [string, string];
  const exp = Number(expRaw);
  const neg = mantissaRaw.startsWith('-');
  const mantissa = neg ? mantissaRaw.slice(1) : mantissaRaw;
  const [intPart, fracPart = ''] = mantissa.split('.') as [string, string?];
  const digits = intPart + fracPart;
  const pointPos = intPart.length + exp; // 小数点在 digits 里的新位置
  let out: string;
  if (pointPos <= 0) {
    out = `0.${'0'.repeat(-pointPos)}${digits}`;
  } else if (pointPos >= digits.length) {
    out = digits + '0'.repeat(pointPos - digits.length);
  } else {
    out = `${digits.slice(0, pointPos)}.${digits.slice(pointPos)}`;
  }
  out = out.includes('.') ? out.replace(/\.?0+$/, '') : out;
  return neg ? `-${out}` : out;
}

/** 单元格值 → 字符串。公式格取 cached result（递归一次）；richText 拼接；错误格取错误码原文。 */
function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return numberToDecimalString(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('text' in value && value.text !== undefined) {
      // hyperlink：text 可能还是 richText 结构
      return typeof value.text === 'string' ? value.text : cellToString(value.text as ExcelJS.CellValue);
    }
    if ('error' in value) return String(value.error);
    if ('result' in value && value.result !== undefined) return cellToString(value.result as ExcelJS.CellValue);
    if ('formula' in value || 'sharedFormula' in value) return ''; // 公式无缓存结果——按空处理
  }
  return String(value);
}

/**
 * 读 workbook，逐 sheet 产出规范 CSV 文本。空 sheet（无任何值）跳过。
 * 加密 / 损坏的 xlsx 由 exceljs 抛错，调用方转明确失败提示，不产出半截结果。
 */
export async function convertXlsxToCsvSheets(xlsxAbsPath: string): Promise<ConvertedSheet[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxAbsPath);
  const sheets: ConvertedSheet[] = [];
  for (const ws of wb.worksheets) {
    const grid: string[][] = [];
    // includeEmpty 把中部空行带上；row.values 是 1 起的稀疏数组，逐列补空串成矩形
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: string[] = [];
      for (let c = 1; c <= ws.columnCount; c++) {
        cells.push(cellToString(row.getCell(c).value));
      }
      grid[rowNumber - 1] = cells;
    });
    // eachRow 跳过的中部空行在 grid 里是 hole，补成空行
    for (let i = 0; i < grid.length; i++) {
      if (!grid[i]) grid[i] = Array.from({ length: ws.columnCount }, () => '');
    }
    // 裁尾部幻影维度：先裁全空尾行，再裁全空尾列（Excel 摸过又清空的格会撑大 dimensions）
    while (grid.length > 0 && grid[grid.length - 1]!.every((v) => v === '')) grid.pop();
    while (grid.length > 0 && grid.every((row) => row[row.length - 1] === '')) {
      for (const row of grid) row.pop();
    }
    if (grid.length === 0) continue;
    const [headers = [], ...rows] = grid;
    sheets.push({ name: ws.name, csv: serializeCsv({ headers, rows }) });
  }
  return sheets;
}
