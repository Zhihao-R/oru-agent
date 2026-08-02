/**
 * previewXlsx —— xlsx 只读预览（内存转换，零落盘）。
 *
 * 与 importXlsx 完全解耦：不碰 inFlight / pendingConflicts / 任何落盘，只共享
 * convertXlsxToCsvSheets 纯函数。预览是请求-应答语义——失败由 handler 转成失败回执，
 * 不走 table.importFailed 广播通道。
 *
 * 超限口径与 openCsv 同源：数据行 > ROW_LIMIT 时截到表头 + 前 1,000 行并置 overLimit
 * （渲染层按此显示「只读预览前 1,000 行」，与 CSV 超限只读预览同一产品语义）。
 */
import { promises as fs } from 'node:fs';
import { parseCsv, serializeCsv } from '@shared/csv';
import { PREVIEW_ROWS, ROW_LIMIT } from '@shared/tableLimits';
import type { TableXlsxPreviewSheet } from '@shared/protocol';
import { ensureWithinProject } from '../fs/projectPath';
import { convertXlsxToCsvSheets } from './convertXlsx';

export async function previewXlsxFile(
  projectRoot: string,
  relPath: string,
): Promise<TableXlsxPreviewSheet[]> {
  const abs = await ensureWithinProject(projectRoot, relPath);
  // 显式判存在：exceljs 对缺文件抛的是无 code 的裸 Error（'File not found: ...'），
  // handler 要靠带 code 的错误把「不存在」与「损坏」拆成两条文案（同 read_file xlsx 分支）。
  await fs.stat(abs);
  const sheets = await convertXlsxToCsvSheets(abs); // 加密/损坏/空簿由 exceljs 抛错或返回空，handler 转失败回执
  return sheets.map(({ name, csv }) => {
    const { headers, rows } = parseCsv(csv);
    if (rows.length <= ROW_LIMIT) {
      return { name, csv, totalRows: rows.length, overLimit: false };
    }
    return {
      name,
      csv: serializeCsv({ headers, rows: rows.slice(0, PREVIEW_ROWS) }),
      totalRows: rows.length,
      overLimit: true,
    };
  });
}
