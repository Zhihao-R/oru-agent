import { describe, it, expect } from 'vitest';
import { inlineKatexFonts, buildKatexStyleTag } from '../../electron/main/export/katexAssets';

/**
 * KaTeX 字体内联（技术方案 §四）：导出物自包含的硬要求——katex.min.css 含 ~60 处 url(fonts/…) 相对引用，
 * 断网/移走源目录后字体找不到、公式排版崩。只内联 woff2（Chromium 与现代浏览器都支持），并剥掉
 * woff/ttf 后备引用，得到真自包含且最小体积的 <style>。
 */
describe('inlineKatexFonts', () => {
  const css =
    '@font-face{font-family:KaTeX_AMS;src:url(fonts/KaTeX_AMS-Regular.woff2) format("woff2"),' +
    'url(fonts/KaTeX_AMS-Regular.woff) format("woff"),' +
    'url(fonts/KaTeX_AMS-Regular.ttf) format("truetype")}.katex{font-size:1.21em}';

  it('woff2 转 data URI 内联', async () => {
    const out = await inlineKatexFonts(css, async () => Buffer.from('FONTBYTES'));
    expect(out).toContain('data:font/woff2;base64,');
    expect(out).toContain(Buffer.from('FONTBYTES').toString('base64'));
    // 非字体规则原样保留
    expect(out).toContain('.katex{font-size:1.21em}');
  });

  it('剥掉 woff/ttf 后备引用（不留 fonts/ 相对引用）', async () => {
    const out = await inlineKatexFonts(css, async () => Buffer.from('X'));
    expect(out).not.toContain('fonts/KaTeX_AMS-Regular.woff)');
    expect(out).not.toContain('fonts/KaTeX_AMS-Regular.ttf)');
    expect(out).not.toMatch(/url\(fonts\//); // 不剩任何 fonts/ 相对引用 = 自包含
  });

  it('字体读盘失败的引用保持原样不抛（不让单个坏字体毁掉整次导出）', async () => {
    const out = await inlineKatexFonts(css, async () => null);
    expect(out).toContain('.katex{font-size:1.21em}');
  });
});

describe('buildKatexStyleTag', () => {
  it('读真实 node_modules katex：产出含 .katex 规则与内联 woff2 的 <style>，无 fonts/ 相对引用', async () => {
    const tag = await buildKatexStyleTag();
    expect(tag).toMatch(/^<style>/);
    expect(tag).toMatch(/<\/style>$/);
    expect(tag).toContain('.katex');
    expect(tag).toContain('data:font/woff2;base64,');
    expect(tag).not.toMatch(/url\(fonts\//);
  });
});
