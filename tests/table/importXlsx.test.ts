/**
 * importXlsx 编排合约 —— diff 冲突判定（"改没改过"不靠账本，比内容）、TOCTOU 重读、
 * in-flight 去重、sheet 拆分命名细则、逐 sheet 结构化结果（ImportOutcome）与
 * 冲突解决后的 table.importWritten 广播。
 *
 * PRD 验收 3 的判据钉在这里：未经修改的 CSV 再次转换同一 xlsx 必须静默且零写盘（mtime 不动）。
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import type { ServerEventPayload } from '@shared/protocol';
import {
  importXlsxFile,
  resetImportStateForTest,
  resolveImportConflict,
} from '../../electron/main/table/importXlsx';

let root: string;
let events: ServerEventPayload[];
const broadcast = (e: ServerEventPayload): void => {
  events.push(e);
};

const PRJ = 'p1';

async function makeXlsx(file: string, sheets: Record<string, string[][]>): Promise<void> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const row of rows) ws.addRow(row);
  }
  await wb.xlsx.writeFile(join(root, file));
}

const conflicts = () => events.filter((e) => e.type === 'table.importConflict');
const csv = (rel: string): string => readFileSync(join(root, rel), 'utf-8');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-import-'));
  events = [];
  resetImportStateForTest();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('importXlsxFile', () => {
  it('首次导入单 sheet：产出 基名.csv，规范格式', async () => {
    await makeXlsx('book.xlsx', { 明细: [['a', 'b'], ['1', '2']] });
    const r = await importXlsxFile(PRJ, root, 'book.xlsx', broadcast);
    expect(csv('book.csv')).toBe('a,b\n1,2\n');
    expect(r).toEqual({ sheets: [{ name: '明细', targetPath: 'book.csv', status: 'written' }] });
    expect(conflicts()).toEqual([]);
  });

  it('未改动重拖：静默刷新且零写盘（mtime 不动）——转换确定性的判据', async () => {
    await makeXlsx('book.xlsx', { 明细: [['a', 'b'], ['1', '2']] });
    await importXlsxFile(PRJ, root, 'book.xlsx', broadcast);
    const old = new Date('2020-01-01');
    utimesSync(join(root, 'book.csv'), old, old);
    const mtimeBefore = statSync(join(root, 'book.csv')).mtimeMs;

    const r = await importXlsxFile(PRJ, root, 'book.xlsx', broadcast);
    expect(r).toEqual({ sheets: [{ name: '明细', targetPath: 'book.csv', status: 'identical' }] });
    expect(statSync(join(root, 'book.csv')).mtimeMs).toBe(mtimeBefore);
    expect(conflicts()).toEqual([]);
  });

  it('CSV 被改后重拖：弹冲突；覆盖 → 文件变为转换结果', async () => {
    await makeXlsx('book.xlsx', { 明细: [['a', 'b'], ['1', '2']] });
    await importXlsxFile(PRJ, root, 'book.xlsx', broadcast);
    writeFileSync(join(root, 'book.csv'), 'a,b\n1,99\n'); // 手改
    const r = await importXlsxFile(PRJ, root, 'book.xlsx', broadcast);
    expect(r).toEqual({ sheets: [{ name: '明细', targetPath: 'book.csv', status: 'conflict' }] });
    const c = conflicts();
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ targetPath: 'book.csv', xlsxPath: 'book.xlsx' });

    const wr = await resolveImportConflict((c[0] as { conflictId: string }).conflictId, 'overwrite', broadcast);
    expect(wr.outcome).toBe('written');
    expect(csv('book.csv')).toBe('a,b\n1,2\n');
    // 覆盖写盘后广播 importWritten（预览原地切换的感知通道）
    expect(events.some((e) => e.type === 'table.importWritten' && e.targetPath === 'book.csv')).toBe(true);
  });

  it('另存：加序号写新文件，原 CSV 不动', async () => {
    await makeXlsx('book.xlsx', { 明细: [['a', 'b'], ['1', '2']] });
    writeFileSync(join(root, 'book.csv'), '手工维护的表\n');
    await importXlsxFile(PRJ, root, 'book.xlsx', broadcast);
    const c = conflicts()[0] as { conflictId: string };
    const r = await resolveImportConflict(c.conflictId, 'saveAs', broadcast);
    expect(r).toMatchObject({ outcome: 'savedAs', savedAsPath: 'book-2.csv' });
    expect(csv('book.csv')).toBe('手工维护的表\n');
    expect(csv('book-2.csv')).toBe('a,b\n1,2\n');
    // 另存也广播 importWritten，targetPath=另存路径
    expect(events.some((e) => e.type === 'table.importWritten' && e.targetPath === 'book-2.csv')).toBe(true);
  });

  it('取消：什么都不动', async () => {
    await makeXlsx('book.xlsx', { 明细: [['a', 'b'], ['1', '2']] });
    writeFileSync(join(root, 'book.csv'), '手工\n');
    await importXlsxFile(PRJ, root, 'book.xlsx', broadcast);
    const c = conflicts()[0] as { conflictId: string };
    const r = await resolveImportConflict(c.conflictId, 'cancel', broadcast);
    expect(r.outcome).toBe('cancelled');
    expect(csv('book.csv')).toBe('手工\n');
    expect(readdirSync(root).sort()).toEqual(['book.csv', 'book.xlsx']);
  });

  it('TOCTOU：弹窗挂起期间磁盘又变 → 覆盖前重新 diff，不按陈旧判定直接写', async () => {
    await makeXlsx('book.xlsx', { 明细: [['a', 'b'], ['1', '2']] });
    writeFileSync(join(root, 'book.csv'), '旧改动\n');
    await importXlsxFile(PRJ, root, 'book.xlsx', broadcast);
    const c = conflicts()[0] as { conflictId: string };

    writeFileSync(join(root, 'book.csv'), '弹窗挂起期间的新改动\n'); // 比如用户 ⌘S 落了盘
    const r = await resolveImportConflict(c.conflictId, 'overwrite', broadcast);
    expect(r.outcome).toBe('reconflict');
    expect(csv('book.csv')).toBe('弹窗挂起期间的新改动\n');
    expect(conflicts()).toHaveLength(2); // 按新快照重发了一条

    // 挂起期间磁盘恰好变成了转换结果 → 视为已一致，直接成功不写
    const c2 = conflicts()[1] as { conflictId: string };
    writeFileSync(join(root, 'book.csv'), 'a,b\n1,2\n');
    const r2 = await resolveImportConflict(c2.conflictId, 'overwrite', broadcast);
    expect(r2.outcome).toBe('written');
  });

  it('并发去重：同一 xlsx 两入口紧邻触发 → 单次转换单次弹窗', async () => {
    await makeXlsx('book.xlsx', { 明细: [['a', 'b'], ['1', '2']] });
    writeFileSync(join(root, 'book.csv'), '手改\n');
    await Promise.all([
      importXlsxFile(PRJ, root, 'book.xlsx', broadcast),
      importXlsxFile(PRJ, root, 'book.xlsx', broadcast),
    ]);
    expect(conflicts()).toHaveLength(1);
  });

  it('多 sheet 拆多文件；清洗后撞名加序号', async () => {
    // 华<东 与 华>东 清洗后同为 华-东 → 第二个加序号
    await makeXlsx('q2.xlsx', { '华<东': [['a']], '华>东': [['b']], 汇总: [['c']] });
    await importXlsxFile(PRJ, root, 'q2.xlsx', broadcast);
    expect(readdirSync(root).sort()).toEqual(['q2-华-东-2.csv', 'q2-华-东.csv', 'q2-汇总.csv', 'q2.xlsx']);
    expect(csv('q2-华-东.csv')).toBe('a\n');
    expect(csv('q2-华-东-2.csv')).toBe('b\n');
  });

  it('sheet 改名：上次拆出的文件本次未出现 → 提示级通知，旧文件保留', async () => {
    await makeXlsx('q2.xlsx', { 华东: [['a']], 华北: [['b']] });
    await importXlsxFile(PRJ, root, 'q2.xlsx', broadcast);
    await makeXlsx('q2.xlsx', { 华东: [['a']], 华南: [['c']] }); // 华北 改名 华南
    await importXlsxFile(PRJ, root, 'q2.xlsx', broadcast);

    const notices = events.filter((e) => e.type === 'table.importNotice');
    expect(notices).toHaveLength(1);
    expect((notices[0] as { message: string }).message).toContain('q2-华北.csv');
    expect(csv('q2-华北.csv')).toBe('b\n'); // 保留不动
    expect(csv('q2-华南.csv')).toBe('c\n');
  });

  it('多 sheet 降为单 sheet：旧拆分文件同样提示；「另存」的序号副本不误报', async () => {
    await makeXlsx('q3.xlsx', { 华东: [['a']], 华北: [['b']] });
    await importXlsxFile(PRJ, root, 'q3.xlsx', broadcast);
    writeFileSync(join(root, 'q3-2.csv'), '另存的序号副本\n'); // 模拟此前「另存」产物
    await makeXlsx('q3.xlsx', { 华东: [['a']] }); // 删减到单 sheet
    await importXlsxFile(PRJ, root, 'q3.xlsx', broadcast);

    const notices = events.filter((e) => e.type === 'table.importNotice');
    expect(notices).toHaveLength(1);
    const msg = (notices[0] as { message: string }).message;
    expect(msg).toContain('q3-华东.csv'); // 单 sheet 后目标变 q3.csv，旧拆分文件全部提示
    expect(msg).toContain('q3-华北.csv');
    expect(msg).not.toContain('q3-2.csv'); // 纯数字序号副本不误报
  });

  it('损坏的 xlsx：明确失败事件，不产出半截 CSV', async () => {
    writeFileSync(join(root, 'bad.xlsx'), 'not a zip');
    await importXlsxFile(PRJ, root, 'bad.xlsx', broadcast);
    expect(events.some((e) => e.type === 'table.importFailed')).toBe(true);
    expect(readdirSync(root)).toEqual(['bad.xlsx']);
  });
});
