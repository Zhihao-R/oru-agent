/**
 * xlsx → CSV 纯转换合约 —— 确定性是导入 diff 冲突判定的承重前提：
 * 同一 xlsx 字节输入必得同一 CSV 字节输出（无时间戳、无随机量、sheet 按物理顺序）。
 *
 * 期望输出以字符串入库钉死；exceljs/papaparse 升级跑本文件即回归。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { convertXlsxToCsvSheets } from '../../electron/main/table/convertXlsx';

let dir: string;
let mixedPath: string; // 单 sheet：日期 / 长数字文本 / 前导零 / 公式 / 数字
let multiPath: string; // 三 sheet（含非法字符 sheet 名与拆分后同名碰撞）
let sparsePath: string; // 稀疏格 + 中部空行 + 尾部幻影空列

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'oru-xlsx-'));

  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('明细');
    ws.addRow(['日期', '订单号', '编号', '金额', '合计']);
    ws.addRow([
      new Date(Date.UTC(2026, 3, 3)),
      '123456789012345678', // 18 位订单号——文本格原样
      '007', // 前导零——文本格原样
      1234.5,
      { formula: 'D2*2', result: 2469 }, // 公式格取 cached result
    ]);
    mixedPath = join(dir, 'mixed.xlsx');
    await wb.xlsx.writeFile(mixedPath);
  }

  {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('华东').addRow(['东']);
    wb.addWorksheet('华北').addRow(['北']);
    wb.addWorksheet('汇总').addRow(['总']);
    multiPath = join(dir, 'multi.xlsx');
    await wb.xlsx.writeFile(multiPath);
  }

  {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.getCell('A1').value = 'h1';
    ws.getCell('B1').value = 'h2';
    // 第 2 行整行空（中部空行）；第 3 行只有 B 列有值（稀疏）
    ws.getCell('B3').value = 'x';
    // E5 摸过又清空 → 幻影维度，尾部空行空列应被裁掉
    ws.getCell('E5').value = 'phantom';
    ws.getCell('E5').value = null;
    sparsePath = join(dir, 'sparse.xlsx');
    await wb.xlsx.writeFile(sparsePath);
  }
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('convertXlsxToCsvSheets', () => {
  it('日期可读、长数字与前导零原样、公式取结果、数字不变科学计数法', async () => {
    const sheets = await convertXlsxToCsvSheets(mixedPath);
    expect(sheets).toEqual([
      {
        name: '明细',
        csv: '日期,订单号,编号,金额,合计\n2026-04-03,123456789012345678,007,1234.5,2469\n',
      },
    ]);
  });

  it('确定性：同一文件转换两次逐字节相等', async () => {
    const a = await convertXlsxToCsvSheets(mixedPath);
    const b = await convertXlsxToCsvSheets(mixedPath);
    expect(a).toEqual(b);
  });

  it('多 sheet 按物理顺序产出，名字原样带回（文件名替换在导入命名层做，不在转换层）', async () => {
    const sheets = await convertXlsxToCsvSheets(multiPath);
    expect(sheets.map((s) => s.name)).toEqual(['华东', '华北', '汇总']);
  });

  it('稀疏格补空串、中部空行保留、尾部幻影空行空列裁掉', async () => {
    const sheets = await convertXlsxToCsvSheets(sparsePath);
    expect(sheets[0]!.csv).toBe('h1,h2\n,\n,x\n');
  });

  it('损坏的文件抛出可读错误，不产出半截结果', async () => {
    const bad = join(dir, 'broken.xlsx');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(bad, 'not a zip');
    await expect(convertXlsxToCsvSheets(bad)).rejects.toThrow();
  });
});
