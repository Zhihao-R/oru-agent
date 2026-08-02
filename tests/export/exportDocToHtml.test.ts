import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { exportDocToHtml } from '../../electron/main/export/exportDocToHtml';
import { docImageUrl } from '../../src/lib/docImageUrl';

/**
 * HTML 单文件出口（技术方案 §四）：把渲染端传入的完整 HTML 里的 oru-doc-img:// 图引用转 data URI、
 * 注入内联了字体的 katex <style>，原子落盘到源文档同目录、同名换后缀、撞名加序号。导出只读源 md。
 */
describe('exportDocToHtml', () => {
  let projectRoot: string;
  const docRel = '笔记/报告.md';
  let docAbs: string;
  let assetsDir: string;
  const resolveProjectRoot = async (id: string) => (id === 'p1' ? projectRoot : null);

  // 1×1 PNG
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  );

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'oru-docexport-'));
    docAbs = join(projectRoot, '笔记', '报告.md');
    assetsDir = join(projectRoot, '笔记', '报告.assets');
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(docAbs, '# 报告');
    writeFileSync(join(assetsDir, 'pic.png'), PNG);
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  // 渲染端会产出的完整 HTML（最小版）：含一张协议图 + 一个 </head> 注入点
  const htmlWith = (imgRef: string): string => {
    const url = docImageUrl(imgRef, { projectId: 'p1', docPath: docRel });
    return `<!DOCTYPE html><html><head><style>.x{}</style></head><body><div class="oru-chat-md"><img src="${url}"/></div></body></html>`;
  };

  it('oru-doc-img:// 图引用转 data URI（自包含、不剩协议引用）', async () => {
    const { path, html } = await exportDocToHtml(docAbs, htmlWith('报告.assets/pic.png'), resolveProjectRoot);
    expect(path).toBe(join(projectRoot, '笔记', '报告.html'));
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain('oru-doc-img://');
  });

  it('注入内联字体的 katex <style>（.katex + woff2 data URI）', async () => {
    const { html } = await exportDocToHtml(docAbs, htmlWith('报告.assets/pic.png'), resolveProjectRoot);
    expect(html).toContain('.katex');
    expect(html).toContain('data:font/woff2;base64,');
    expect(html).not.toMatch(/url\(fonts\//);
  });

  it('落盘到源文档同目录、同名换后缀；撞名加序号不覆盖', async () => {
    const first = await exportDocToHtml(docAbs, htmlWith('报告.assets/pic.png'), resolveProjectRoot);
    expect(existsSync(first.path)).toBe(true);
    const second = await exportDocToHtml(docAbs, htmlWith('报告.assets/pic.png'), resolveProjectRoot);
    expect(second.path).toBe(join(projectRoot, '笔记', '报告-2.html'));
  });

  it('缺失图：仍产出，缺失清单上报，不留 .tmp 残件', async () => {
    const { missing } = await exportDocToHtml(docAbs, htmlWith('报告.assets/nope.png'), resolveProjectRoot);
    expect(missing.length).toBe(1);
    const residue = readdirSync(join(projectRoot, '笔记')).filter((f) => f.includes('.tmp'));
    expect(residue).toEqual([]);
  });

  it('导出只读源 md：源文件内容不变', async () => {
    await exportDocToHtml(docAbs, htmlWith('报告.assets/pic.png'), resolveProjectRoot);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(docAbs, 'utf-8')).toBe('# 报告');
  });
});
