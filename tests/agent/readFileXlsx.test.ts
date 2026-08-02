/**
 * read_file 读 xlsx —— .xlsx 路径内存转 CSV 文本（多 sheet 以「# Sheet: 名」分段），
 * 零落盘，走与普通大文本同一套行分页闸。
 *
 * pathSandbox 放行、convertXlsx mock（避开真 exceljs 加载）——本测试只验 read_file 的
 * 分流与拼段/分页行为；真转换由 convertXlsx.test.ts 自身覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeToolContext } from '../helpers/toolContext';

vi.mock('../../electron/main/agent/agentTools/pathSandbox', async (orig) => {
  const actual = await orig<typeof import('../../electron/main/agent/agentTools/pathSandbox')>();
  return { ...actual, assertReadableSandbox: vi.fn(async () => {}) };
});

let sheets: { name: string; csv: string }[] = [];
let shouldThrow: NodeJS.ErrnoException | null = null;
vi.mock('../../electron/main/table/convertXlsx', () => ({
  convertXlsxToCsvSheets: vi.fn(async () => {
    if (shouldThrow) throw shouldThrow;
    return sheets;
  }),
}));

import { makeReadFileTool } from '../../electron/main/agent/agentTools/readFile';

const ctx = makeToolContext({ conversationId: 'c-xlsx', agentId: 'a1', ownerId: 'o1' });

let dir: string;
afterEach(() => {
  sheets = [];
  shouldThrow = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function makeFile(name: string): string {
  dir = mkdtempSync(join(tmpdir(), 'readxlsx-'));
  const p = join(dir, name);
  writeFileSync(p, Buffer.from([0x50, 0x4b])); // PK（内容不重要，转换器已 mock）
  return p;
}

describe('read_file 读 xlsx', () => {
  it('单 sheet：CSV 文本带 sheet 分段头，零落盘', async () => {
    sheets = [{ name: '明细', csv: 'a,b\n1,2\n' }];
    const p = makeFile('book.xlsx');

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain('# Sheet: 明细');
    expect(res.text).toContain('a,b');
    expect(readdirSync(dir)).toEqual(['book.xlsx']); // 不产生任何文件
  });

  it('多 sheet：按顺序分段拼接', async () => {
    sheets = [
      { name: '华东', csv: 'a\n1\n' },
      { name: '华北', csv: 'b\n2\n' },
    ];
    const p = makeFile('q2.xlsx');

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    const i1 = res.text!.indexOf('# Sheet: 华东');
    const i2 = res.text!.indexOf('# Sheet: 华北');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i2).toBeGreaterThan(i1);
  });

  it('offset/limit：按拼出的文本分页（与大文本同一闸）', async () => {
    sheets = [{ name: '数据', csv: Array.from({ length: 50 }, (_, i) => `r${i + 1},v`).join('\n') + '\n' }];
    const p = makeFile('page.xlsx');

    const res = await makeReadFileTool().execute({ path: p, offset: 5, limit: 3 }, ctx);
    expect(res.isError).toBeFalsy();
    // 文本第 1 行是分段头，第 2 行起是 r1…：offset=5 → r4 起 3 行
    expect(res.text).toContain('r4,v');
    expect(res.text).toContain('r6,v');
    expect(res.text).not.toContain('r3,v');
    expect(res.text).not.toContain('r7,v');
  });

  it('解析失败 → isError（不静默返回空）', async () => {
    shouldThrow = new Error('bad zip');
    const p = makeFile('enc.xlsx');

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('xlsx 解析失败');
  });

  it('空工作簿 → 明确"没有发现数据"（与预览/导入同口径，不静默返回空文本）', async () => {
    sheets = [];
    const p = makeFile('empty.xlsx');

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain('没有发现数据');
  });

  it('文件不存在 → isError ENOENT 文案（stat 在转换前判存在，mock 不会被调）', async () => {
    // exceljs 对缺文件抛无 code 裸 Error——分支里的 ENOENT 来自前置 fs.stat 的真实错误，
    // 不是转换器抛的，所以这里用磁盘上真实不存在的路径（convertXlsx mock 不参与）
    dir = mkdtempSync(join(tmpdir(), 'readxlsx-'));
    const p = join(dir, 'ghost.xlsx');

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('文件不存在');
  });
});
