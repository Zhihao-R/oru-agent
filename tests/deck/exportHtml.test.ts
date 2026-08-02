/**
 * HTML 导出单测：
 * - inlineAssets 纯函数：本地引用内联成 data URI、外链/data: 原样留、缺失资源不抛且计数。
 * - shouldIncludeInZip 纯函数：剔除隐藏项与既往导出物。
 * - exportDeckToInlineHtml / exportDeckToZip：真实 fs（临时目录），验产物内容与剔除规则。
 * 渲染相关（PPT）需 Electron，不在此。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import {
  inlineAssets,
  shouldIncludeInZip,
  exportDeckToInlineHtml,
  exportDeckToZip,
} from '../../electron/main/deck/exportHtml';

describe('inlineAssets', () => {
  it('本地 src / url() 替换成 data URI，外链与 data: 原样留', async () => {
    const html =
      '<img src="images/a.png">' +
      '<img src="https://cdn.example/b.png">' +
      '<style>.x{background:url(images/bg.jpg)}@font-face{src:url("fonts/f.woff2")}</style>' +
      '<img src="data:image/png;base64,ZZ">';
    const resolve = async (ref: string) =>
      ref === 'images/a.png' || ref === 'images/bg.jpg' || ref === 'fonts/f.woff2'
        ? Buffer.from('X')
        : null;
    const { html: out, missing } = await inlineAssets(html, resolve);
    expect(out).toContain('src="data:image/png;base64,WA=="'); // 'X' → base64
    expect(out).toContain('url(data:image/jpeg;base64,WA==)');
    expect(out).toContain('url("data:font/woff2;base64,WA==")');
    // 外链与已是 data: 的不动
    expect(out).toContain('src="https://cdn.example/b.png"');
    expect(out).toContain('src="data:image/png;base64,ZZ"');
    expect(missing).toEqual([]);
  });

  it('缺失的本地资源不抛、保持原引用并计入 missing', async () => {
    const html = '<img src="images/gone.png"><img src="images/ok.png">';
    const resolve = async (ref: string) => (ref === 'images/ok.png' ? Buffer.from('Y') : null);
    const { html: out, missing } = await inlineAssets(html, resolve);
    expect(out).toContain('src="images/gone.png"'); // 原样留
    expect(out).toContain('src="data:image/png;base64,'); // ok 的被内联
    expect(missing).toEqual(['images/gone.png']);
  });
});

describe('shouldIncludeInZip', () => {
  it('剔除点开头隐藏项与既往导出物，保留素材', () => {
    const base = '贡嘎';
    expect(shouldIncludeInZip('index.html', base)).toBe(true);
    expect(shouldIncludeInZip('images', base)).toBe(true);
    expect(shouldIncludeInZip('.history', base)).toBe(false);
    expect(shouldIncludeInZip('.annotations.json', base)).toBe(false);
    expect(shouldIncludeInZip('.narrative.md', base)).toBe(false);
    expect(shouldIncludeInZip('贡嘎.pdf', base)).toBe(false);
    expect(shouldIncludeInZip('贡嘎.zip', base)).toBe(false);
    expect(shouldIncludeInZip('贡嘎.html', base)).toBe(false);
    expect(shouldIncludeInZip('贡嘎.pptx', base)).toBe(false);
  });
});

describe('exportDeckToInlineHtml / exportDeckToZip（真实 fs）', () => {
  let deckPath: string;

  beforeEach(async () => {
    deckPath = await fs.mkdtemp(join(tmpdir(), 'deck-export-'));
    await fs.mkdir(join(deckPath, 'images'));
    await fs.writeFile(join(deckPath, 'images', 'a.png'), Buffer.from('PNGDATA'));
    await fs.writeFile(
      join(deckPath, 'index.html'),
      '<!doctype html><html><body><section class="slide"><img src="images/a.png"></section></body></html>',
    );
    // 该被 zip 剔除的项
    await fs.mkdir(join(deckPath, '.history'));
    await fs.writeFile(join(deckPath, '.history', 'v1.html'), 'old');
    await fs.writeFile(join(deckPath, '.narrative.md'), '# 文稿');
  });

  afterEach(async () => {
    await fs.rm(deckPath, { recursive: true, force: true });
  });

  it('越界引用不读 deck 外文件：同前缀兄弟目录的 ../ 引用按缺失处理（前缀边界回归）', async () => {
    // 造一个同前缀兄弟目录 <deck>-bak，放一个机密文件
    const sibling = `${deckPath}-bak`;
    await fs.mkdir(sibling, { recursive: true });
    await fs.writeFile(join(sibling, 'secret.png'), Buffer.from('SECRET'));
    try {
      await fs.writeFile(
        join(deckPath, 'index.html'),
        `<img src="../${basename(sibling)}/secret.png">`,
      );
      const out = await exportDeckToInlineHtml(deckPath);
      const html = await fs.readFile(out, 'utf-8');
      // 越界文件不被读取/内联——原引用保持，不出现 SECRET 的 base64（U0VDUkVU）
      expect(html).not.toContain('U0VDUkVU');
      expect(html).toContain('src="../');
    } finally {
      await fs.rm(sibling, { recursive: true, force: true });
    }
  });

  it('单文件导出：图片内联成 data URI，产物名 = 目录名.html', async () => {
    const out = await exportDeckToInlineHtml(deckPath);
    expect(out.endsWith('.html')).toBe(true);
    const html = await fs.readFile(out, 'utf-8');
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).not.toContain('src="images/a.png"');
  });

  it('zip 导出：含 index.html + images/，剔除 .history/.narrative.md 与自身既往导出物', async () => {
    // 预置一份既往导出物，确认不被卷进新 zip
    const base = deckPath.split('/').pop()!;
    await fs.writeFile(join(deckPath, `${base}.pdf`), 'old pdf');

    const out = await exportDeckToZip(deckPath);
    const zip = await JSZip.loadAsync(await fs.readFile(out));
    const names = Object.keys(zip.files);
    expect(names).toContain('index.html');
    expect(names.some((n) => n.startsWith('images/'))).toBe(true);
    expect(names.some((n) => n.startsWith('.history'))).toBe(false);
    expect(names).not.toContain('.narrative.md');
    expect(names.some((n) => n.endsWith('.pdf'))).toBe(false);
    expect(names.some((n) => n.endsWith('.zip'))).toBe(false);
  });
});

describe('导出注入分发态 runtime（预览态纯内容，导出才补缩放/翻页）', () => {
  let deckPath: string;
  beforeEach(async () => {
    deckPath = await fs.mkdtemp(join(tmpdir(), 'deck-runtime-'));
    await fs.writeFile(
      join(deckPath, 'index.html'),
      '<!doctype html><html><body><section class="slide">a</section><section class="slide">b</section></body></html>',
    );
  });
  afterEach(async () => {
    await fs.rm(deckPath, { recursive: true, force: true });
  });

  it('单文件导出注入自包含 runtime（缩放 + 显隐骨架），且在 </body> 前', async () => {
    const out = await exportDeckToInlineHtml(deckPath);
    const html = await fs.readFile(out, 'utf-8');
    expect(html).toContain('<script data-oru-runtime>');
    expect(html).toContain('translate(-50%,-50%) scale(');
    expect(html).toContain('.slide[data-oru-active]');
    expect(html.indexOf('data-oru-runtime')).toBeLessThan(html.indexOf('</body>'));
  });

  it('缺 oru-deck-size meta 时 runtime 退回默认 1920x1080', async () => {
    const out = await exportDeckToInlineHtml(deckPath);
    const html = await fs.readFile(out, 'utf-8');
    expect(html).toContain('var W=1920, H=1080');
  });

  it('声明的画布尺寸透传进 runtime', async () => {
    await fs.writeFile(
      join(deckPath, 'index.html'),
      '<!doctype html><html><head><meta name="oru-deck-size" content="1024x768"></head><body><section class="slide">x</section></body></html>',
    );
    const out = await exportDeckToInlineHtml(deckPath);
    const html = await fs.readFile(out, 'utf-8');
    expect(html).toContain('var W=1024, H=768');
  });

  it('zip 内 index.html 同样注入 runtime（解压即可独立播放）', async () => {
    const out = await exportDeckToZip(deckPath);
    const zip = await JSZip.loadAsync(await fs.readFile(out));
    const indexHtml = await zip.file('index.html')!.async('string');
    expect(indexHtml).toContain('<script data-oru-runtime>');
  });
});
