/**
 * buildXlsxFromCsv —— CSV → xlsx 字节口径与导入对称：长数字/前导零写文本格（Excel 不变科学
 * 计数法、不吃前导零）、日期列写日期类型、可解析的数写数字格。写到哪由 handler 弹对话框选，
 * 本模块只出字节 + 建议名。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { buildXlsxFromCsv } from '../../electron/main/table/exportXlsx';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-export-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('buildXlsxFromCsv', () => {
  it('日期列→日期类型；18 位订单号与前导零→文本格；金额→数字格；建议名=基名.xlsx', async () => {
    writeFileSync(
      join(root, '汇总.csv'),
      '日期,订单号,编号,金额\n2026-04-03,123456789012345678,007,1234.5\n',
    );
    const { buffer, suggestedName } = await buildXlsxFromCsv(root, '汇总.csv');
    expect(suggestedName).toBe('汇总.xlsx');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0]!;
    expect(ws.getCell('A2').value).toBeInstanceOf(Date);
    expect(ws.getCell('B2').value).toBe('123456789012345678');
    expect(ws.getCell('C2').value).toBe('007');
    expect(ws.getCell('D2').value).toBe(1234.5);
  });

  it('拒绝读不到的源文件', async () => {
    await expect(buildXlsxFromCsv(root, 'a.md')).rejects.toThrow();
  });
});
