/**
 * previewXlsx 合约 —— 内存转换零落盘、多 sheet 返回、超限截断（表头+前 N 行）、损坏抛错。
 *
 * 超限用例把 @shared/tableLimits mock 成小值（ROW_LIMIT=5 / PREVIEW_ROWS=2）——
 * 真 10 万行的 exceljs 建模+解析是分钟级，测试的是截断分支本身而非 exceljs 的吞吐。
 */
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';

vi.mock('@shared/tableLimits', () => ({ ROW_LIMIT: 5, PREVIEW_ROWS: 2 }));

import { previewXlsxFile } from '../../electron/main/table/previewXlsx';
import { parseCsv } from '@shared/csv';

let root: string;

async function makeXlsx(file: string, sheets: Record<string, string[][]>): Promise<void> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  await wb.xlsx.writeFile(join(root, file));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-preview-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('previewXlsxFile', () => {
  it('单 sheet：返回 CSV 文本与行数，overLimit=false；零落盘', async () => {
    await makeXlsx('book.xlsx', { 明细: [['a', 'b'], ['1', '2'], ['3', '4']] });
    const sheets = await previewXlsxFile(root, 'book.xlsx');
    expect(sheets).toEqual([{ name: '明细', csv: 'a,b\n1,2\n3,4\n', totalRows: 2, overLimit: false }]);
    expect(readdirSync(root)).toEqual(['book.xlsx']); // 预览不产生任何文件
  });

  it('多 sheet：按 workbook 物理顺序逐个返回', async () => {
    await makeXlsx('q2.xlsx', { 华东: [['a'], ['1']], 华北: [['b'], ['2']] });
    const sheets = await previewXlsxFile(root, 'q2.xlsx');
    expect(sheets.map((s) => s.name)).toEqual(['华东', '华北']);
    expect(sheets[0]!.csv).toBe('a\n1\n');
    expect(sheets[1]!.csv).toBe('b\n2\n');
  });

  it('空 sheet 跳过；全空工作簿返回空数组', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('空表');
    const ws = wb.addWorksheet('有数');
    ws.addRow(['x']);
    await wb.xlsx.writeFile(join(root, 'mix.xlsx'));
    const sheets = await previewXlsxFile(root, 'mix.xlsx');
    expect(sheets.map((s) => s.name)).toEqual(['有数']);

    await makeXlsxEmpty('empty.xlsx');
    expect(await previewXlsxFile(root, 'empty.xlsx')).toEqual([]);
  });

  it('超限：截到表头 + 前 PREVIEW_ROWS 数据行，overLimit=true，totalRows 是全量', async () => {
    // mock 后 ROW_LIMIT=5 / PREVIEW_ROWS=2：8 行数据 → 截到 2 行
    await makeXlsx('big.xlsx', {
      数据: [['col'], ['1'], ['2'], ['3'], ['4'], ['5'], ['6'], ['7'], ['8']],
    });
    const sheets = await previewXlsxFile(root, 'big.xlsx');
    expect(sheets).toHaveLength(1);
    const s = sheets[0]!;
    expect(s.overLimit).toBe(true);
    expect(s.totalRows).toBe(8);
    const parsed = parseCsv(s.csv);
    expect(parsed.headers).toEqual(['col']);
    expect(parsed.rows).toEqual([['1'], ['2']]);
  });

  it('损坏的 xlsx：抛错（handler 转失败回执），不产出任何文件', async () => {
    writeFileSync(join(root, 'bad.xlsx'), 'not a zip');
    await expect(previewXlsxFile(root, 'bad.xlsx')).rejects.toThrow();
    expect(readdirSync(root)).toEqual(['bad.xlsx']);
  });
});

async function makeXlsxEmpty(file: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('空');
  await wb.xlsx.writeFile(join(root, file));
}
