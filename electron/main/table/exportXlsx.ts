/**
 * exportXlsx —— CSV → xlsx 出境（"门口收门口发，xlsx 始终只是出入境的衣服"）。
 * 只负责把 CSV 编成 xlsx 字节 + 给个建议文件名；写到哪由 handler 弹保存对话框让用户选。
 *
 * 口径与导入对称（PRD 场景五 / 验收 12）：
 *   - 日期列（整列非空值全匹配 YYYY-MM-DD[ HH:mm:ss]）→ 日期类型；
 *   - 超长（≥16 位）纯数字、带前导零的纯数字 → 文本格（numFmt '@'）——否则 Excel
 *     变科学计数法、吃前导零。文本判定按格做，不按列：一列里混进一个 18 位编号，
 *     按列判数字格会让它当场损毁，按格判保数据；
 *   - 其余可解析为数 → 数字格；剩下文本格。
 */
import { basename } from 'node:path';
import ExcelJS from 'exceljs';
import { parseCsv } from '@shared/csv';
import { readTextFile } from '../fs/textFile';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?: (\d{2}):(\d{2}):(\d{2}))?$/;
const TEXT_NUMBER_RE = /^(?:\d{16,}|0\d+)$/; // ≥16 位纯数字 或 前导零编号

function parseDateUtc(value: string): Date | null {
  const m = DATE_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0'] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)));
}

export async function buildXlsxFromCsv(
  projectRoot: string,
  relCsvPath: string,
): Promise<{ buffer: Buffer; suggestedName: string }> {
  const { content } = await readTextFile(projectRoot, relCsvPath);
  const { headers, rows } = parseCsv(content);

  const base = basename(relCsvPath).replace(/\.csv$/i, '');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(base.slice(0, 31) || 'Sheet1'); // Excel sheet 名上限 31 字符

  // 日期列按整列判定（至少一个非空值，且非空值全是日期形态）
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 0);
  const isDateCol: boolean[] = [];
  const colHasTime: boolean[] = [];
  for (let c = 0; c < colCount; c++) {
    const values = rows.map((r) => r[c] ?? '').filter((v) => v !== '');
    isDateCol[c] = values.length > 0 && values.every((v) => DATE_RE.test(v));
    colHasTime[c] = isDateCol[c]! && values.some((v) => v.includes(' '));
  }

  ws.addRow(headers);
  for (const row of rows) {
    const excelRow = ws.addRow([]);
    for (let c = 0; c < colCount; c++) {
      const value = row[c] ?? '';
      const cell = excelRow.getCell(c + 1);
      if (value === '') continue;
      if (isDateCol[c]) {
        cell.value = parseDateUtc(value);
        cell.numFmt = colHasTime[c] ? 'yyyy-mm-dd hh:mm:ss' : 'yyyy-mm-dd';
      } else if (TEXT_NUMBER_RE.test(value)) {
        cell.numFmt = '@';
        cell.value = value;
      } else {
        const n = Number(value);
        cell.value = value.trim() !== '' && Number.isFinite(n) ? n : value;
      }
    }
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return { buffer, suggestedName: `${base}.xlsx` };
}
