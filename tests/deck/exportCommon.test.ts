/**
 * 导出原子落盘单测：成功写入不留 .tmp；失败（目标目录不存在）不留任何残件（PRD：不留半成品）。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import os from 'node:os';
import { exportPath, writeExportAtomic, exportRenderConcurrency } from '../../electron/main/deck/exportCommon';

describe('exportPath', () => {
  let parent: string;
  let deckPath: string;
  beforeEach(async () => {
    parent = await fs.mkdtemp(join(tmpdir(), 'export-path-'));
    deckPath = join(parent, '贡嘎'); // deck 目录名 = 导出基名
    await fs.mkdir(deckPath, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(parent, { recursive: true, force: true });
  });

  it('无撞名：产物名 = deck 目录名 + 扩展名，落在 deck 目录内', async () => {
    expect(await exportPath(deckPath, 'pdf')).toBe(join(deckPath, '贡嘎.pdf'));
  });

  it('撞名：已有基名文件 → 加序号 -2 另存，不覆盖', async () => {
    await fs.writeFile(join(deckPath, '贡嘎.pdf'), 'old');
    expect(await exportPath(deckPath, 'pdf')).toBe(join(deckPath, '贡嘎-2.pdf'));
  });

  it('连续撞名：基名 + -2 都在 → 取 -3', async () => {
    await fs.writeFile(join(deckPath, '贡嘎.pdf'), 'old');
    await fs.writeFile(join(deckPath, '贡嘎-2.pdf'), 'old2');
    expect(await exportPath(deckPath, 'pdf')).toBe(join(deckPath, '贡嘎-3.pdf'));
  });

  it('序号只认同扩展名：已有 .pdf 不影响 .pptx 仍用基名', async () => {
    await fs.writeFile(join(deckPath, '贡嘎.pdf'), 'old');
    expect(await exportPath(deckPath, 'pptx')).toBe(join(deckPath, '贡嘎.pptx'));
  });
});

describe('exportRenderConcurrency', () => {
  it('钳在 [4,12]，且不超过本机逻辑核数（核多时取 12 上限）', () => {
    const c = exportRenderConcurrency();
    const cores = os.availableParallelism?.() ?? os.cpus().length;
    expect(c).toBeGreaterThanOrEqual(4);
    expect(c).toBeLessThanOrEqual(12);
    expect(c).toBe(Math.max(4, Math.min(12, cores)));
  });
});

describe('writeExportAtomic', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'export-atomic-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('成功写入后目录里只有正式文件、无 .tmp 残留', async () => {
    const out = join(dir, 'deck.pptx');
    await writeExportAtomic(out, Buffer.from('PPTX'));
    expect(await fs.readFile(out, 'utf-8')).toBe('PPTX');
    const left = await fs.readdir(dir);
    expect(left).toEqual(['deck.pptx']); // 没有 .deck.pptx.tmp
  });

  it('写入失败（父目录不存在）抛错且不留任何残件', async () => {
    const out = join(dir, 'nope', 'deck.pdf'); // nope/ 不存在 → writeFile(tmp) 失败
    await expect(writeExportAtomic(out, Buffer.from('X'))).rejects.toThrow();
    // dir 下不应出现任何文件
    expect(await fs.readdir(dir)).toEqual([]);
  });
});
