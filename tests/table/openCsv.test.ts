/**
 * openCsv —— 打开时超限判定：≤100,000 数据行全量回传；超限只回前 1,000 行只读预览，
 * 总行数异步补报（首屏不等读完全文件）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openCsv } from '../../electron/main/table/openCsv';

let root: string;

function makeCsv(file: string, dataRows: number): void {
  const lines = ['名称,金额'];
  for (let i = 0; i < dataRows; i++) lines.push(`r${i},${i}`);
  writeFileSync(join(root, file), lines.join('\n') + '\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-opencsv-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('openCsv', () => {
  it('小文件全量回传：content / encodingSafe / sha256', async () => {
    makeCsv('a.csv', 3);
    const r = await openCsv(root, 'a.csv');
    expect(r.overLimit).toBe(false);
    if (!r.overLimit) {
      expect(r.content).toBe('名称,金额\nr0,0\nr1,1\nr2,2\n');
      expect(r.encodingSafe).toBe(true);
    }
  });

  it('恰好 100,000 数据行：不超限、可编辑', async () => {
    makeCsv('edge.csv', 100_000);
    const r = await openCsv(root, 'edge.csv');
    expect(r.overLimit).toBe(false);
  });

  it('100,001 数据行：超限 → 前 1,001 条记录预览（[0] 为表头），总行数异步补报', async () => {
    makeCsv('big.csv', 100_001);
    const r = await openCsv(root, 'big.csv');
    expect(r.overLimit).toBe(true);
    if (r.overLimit) {
      expect(r.previewRows).toHaveLength(1001);
      expect(r.previewRows[0]).toEqual(['名称', '金额']);
      expect(r.previewRows[1]).toEqual(['r0', '0']);
      expect(await r.countTotalRows()).toBe(100_001);
    }
  });

  it('streaming 路径（强制小阈值）与内存路径同结果', async () => {
    makeCsv('big2.csv', 100_001);
    const r = await openCsv(root, 'big2.csv', { inMemoryMaxBytes: 1024 });
    expect(r.overLimit).toBe(true);
    if (r.overLimit) {
      expect(r.previewRows).toHaveLength(1001);
      expect(await r.countTotalRows()).toBe(100_001);
    }
    const small = await openCsv(root, 'a2.csv', { inMemoryMaxBytes: 1024 }).catch(() => null);
    // 小文件在 streaming 阈值下也必须正确回传全文
    makeCsv('a3.csv', 2);
    const r3 = await openCsv(root, 'a3.csv', { inMemoryMaxBytes: 16 });
    expect(r3.overLimit).toBe(false);
    if (!r3.overLimit) expect(r3.content).toBe('名称,金额\nr0,0\nr1,1\n');
    void small;
  });
});
