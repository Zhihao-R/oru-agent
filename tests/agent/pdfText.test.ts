/**
 * extractPdfText 端到端（S34 · G26）——真 pdf-lib 造 PDF、真 pdfjs 抽取，守住 read_file 单测
 * mock 掉的那段真管线（Node 下 fake worker 是否可用、逐页 + 页标记是否成形）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractPdfText } from '../../electron/main/agent/agentTools/pdfText';

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

describe('extractPdfText 端到端', () => {
  it('两页 PDF → 逐页文字 + 页标记', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pdftext-'));
    const p = join(dir, 'two.pdf');
    writeFileSync(p, await makePdf(['Hello page one', 'Second page text']));

    const out = await extractPdfText(p);
    expect(out).toContain('第 1 页 / 共 2 页');
    expect(out).toContain('第 2 页 / 共 2 页');
    expect(out).toContain('Hello page one');
    expect(out).toContain('Second page text');
  });

  it('损坏字节 → 抛错（交由 read_file 翻成 isError）', async () => {
    dir = mkdtempSync(join(tmpdir(), 'pdftext-'));
    const p = join(dir, 'broken.pdf');
    writeFileSync(p, Buffer.from('not a real pdf at all'));

    await expect(extractPdfText(p)).rejects.toThrow();
  });
});
