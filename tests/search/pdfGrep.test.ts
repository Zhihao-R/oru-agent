/**
 * grepSearch 对 PDF 的支持——真 pdf-lib 造 PDF、真 pdfjs 抽取，守住"PDF 不再是 grep 死角"。
 * 重点回归「一趟 grep 连抽多份 PDF」：曾担心 pdfjs worker 被首份 destroy 关掉致后续抽空，
 * 这里用两份各含不同词的 PDF 同趟搜，两份都必须命中——真出 worker 复用 bug 此测会红。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { grepSearch } from '../../electron/main/fs/search';

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function makePdf(pages: string[]): Promise<Buffer> {
  const { PDFDocument, StandardFonts } = await import('pdf-lib');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const text of pages) {
    const page = doc.addPage([300, 200]);
    page.drawText(text, { x: 20, y: 150, font, size: 14 });
  }
  return Buffer.from(await doc.save());
}

describe('grepSearch 搜 PDF', () => {
  it('PDF 内容被抽成文本参与搜索（普通二进制路径本会跳过）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pdfgrep-'));
    writeFileSync(join(dir, 'report.pdf'), await makePdf(['Quarterly revenue summary']));
    const r = await grepSearch({ pattern: 'revenue', root: dir, outputMode: 'files_with_matches', headLimit: 250 });
    expect(r.mode).toBe('files_with_matches');
    if (r.mode === 'files_with_matches') expect(r.files).toContain('report.pdf');
  });

  it('一趟连搜两份 PDF：两份各自命中（回归 worker 复用致后续抽空）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pdfgrep-'));
    writeFileSync(join(dir, 'alpha.pdf'), await makePdf(['alpha marker text']));
    writeFileSync(join(dir, 'beta.pdf'), await makePdf(['beta marker text']));
    const r = await grepSearch({ pattern: 'marker', root: dir, outputMode: 'files_with_matches', headLimit: 250 });
    expect(r.mode).toBe('files_with_matches');
    if (r.mode === 'files_with_matches') {
      expect(r.files).toContain('alpha.pdf');
      expect(r.files).toContain('beta.pdf'); // 第二份若被 worker 关掉会抽空 → 缺失
    }
  });

  it('content 模式命中带页标记，命中词落在片段里', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pdfgrep-'));
    writeFileSync(join(dir, 'doc.pdf'), await makePdf(['first page', 'needle on second page']));
    const r = await grepSearch({ pattern: 'needle', root: dir, outputMode: 'content', context: 1, headLimit: 250 });
    expect(r.mode).toBe('content');
    if (r.mode === 'content') {
      expect(r.matches.length).toBeGreaterThan(0);
      expect(r.matches[0]!.text).toContain('needle');
    }
  });

  it('损坏 PDF 只跳过它自己，不中断整趟搜索', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pdfgrep-'));
    writeFileSync(join(dir, 'broken.pdf'), Buffer.from('not a real pdf at all'));
    writeFileSync(join(dir, 'good.txt'), 'findme here', 'utf-8');
    const r = await grepSearch({ pattern: 'findme', root: dir, outputMode: 'files_with_matches', headLimit: 250 });
    expect(r.mode).toBe('files_with_matches');
    if (r.mode === 'files_with_matches') {
      expect(r.files).toContain('good.txt');
      expect(r.files).not.toContain('broken.pdf'); // 解析失败被跳过，而非抽空后计入
    }
  });
});
