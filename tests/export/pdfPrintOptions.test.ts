import { describe, it, expect } from 'vitest';
import { pdfPrintOptions } from '../../electron/main/export/exportDocToPdf';

/**
 * PDF 物理页几何归主进程（与 pageSize:'A4' 同处）：纸张版分歧在 printToPDF 参数层可判定
 * （margins / 页码）；渲染出的版式差异（衬线/两端对齐/分页）在 CSS，由 playtest 验。
 */
describe('pdfPrintOptions', () => {
  it('两版都是 A4 真分页 + 打印底色', () => {
    for (const paper of [false, true]) {
      const o = pdfPrintOptions(paper);
      expect(o.pageSize).toBe('A4');
      expect(o.printBackground).toBe(true);
    }
  });

  it('纸张版：更规整页边距 + 页码页脚；书本版：较紧页边距、无页脚', () => {
    const book = pdfPrintOptions(false);
    const paper = pdfPrintOptions(true);
    // 纸张版页边距更大（正式打印留白）
    expect(paper.margins!.top).toBeGreaterThan(book.margins!.top!);
    // 纸张版有页码页脚，书本版没有
    expect(paper.displayHeaderFooter).toBe(true);
    expect(paper.footerTemplate).toContain('pageNumber');
    expect(book.displayHeaderFooter).toBe(false);
  });
});
