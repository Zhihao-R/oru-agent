import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportDocToPdf } from '../../electron/main/export/exportDocToPdf';

/**
 * 取消语义回归（§九）：导出已取消时不落盘、目录无残件。
 * 用已 abort 的 signal——withOffscreenPage 在 `await import('electron')` 之前即检查 signal.aborted 抛错，
 * 故无需真 electron 即可验证「取消的导出不产物、无 .tmp 残件」这一承重路径（真分页/文字可选可搜走 playtest）。
 */
describe('exportDocToPdf 取消路径', () => {
  let projectRoot: string;
  let docAbs: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'oru-pdfcancel-'));
    docAbs = join(projectRoot, '报告.md');
    writeFileSync(docAbs, '# 报告');
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  it('已取消的导出：抛错、不落盘、无 .tmp 残件', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const html = '<!DOCTYPE html><html><head></head><body><div class="oru-chat-md"><h1>报告</h1></div></body></html>';
    await expect(
      exportDocToPdf(docAbs, html, { paperMode: false, signal: ctrl.signal }),
    ).rejects.toThrow();
    const files = readdirSync(projectRoot);
    expect(files.filter((f) => f.endsWith('.pdf'))).toEqual([]);
    expect(files.filter((f) => f.includes('.tmp'))).toEqual([]);
  });
});
