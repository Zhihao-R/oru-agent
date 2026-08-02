import { describe, expect, it } from 'vitest';
import { parseImgHtml, buildImageSource } from '../../src/components/editor/livePreview';

/**
 * parseImgHtml —— 把「调过大小/对齐」落成的 HTML 源码解析回 {src,width,align}（§五）。
 * 大小 = <img width>；对齐 = 外包 <p align>（左=不包）。只认本地相对 src（远程/绝对 → null）。
 */
describe('parseImgHtml', () => {
  it('纯 <img src width>：解析出 src 与 width，align 默认 left', () => {
    expect(parseImgHtml('<img src="方案.assets/a.png" width="320" alt="图">')).toEqual({
      src: '方案.assets/a.png',
      width: 320,
      align: 'left',
    });
  });

  it('外包 <p align="center">：解析出 align=center', () => {
    expect(parseImgHtml('<p align="center"><img src="方案.assets/a.png" width="200"></p>')).toEqual({
      src: '方案.assets/a.png',
      width: 200,
      align: 'center',
    });
  });

  it('裸 <img src>：width=null、align=left', () => {
    expect(parseImgHtml('<img src="方案.assets/a.png">')).toEqual({
      src: '方案.assets/a.png',
      width: null,
      align: 'left',
    });
  });

  it('单引号属性也认', () => {
    expect(parseImgHtml(`<img src='方案.assets/a.png' width='120'>`)).toEqual({
      src: '方案.assets/a.png',
      width: 120,
      align: 'left',
    });
  });

  it('width 走 style:width:Npx 也认', () => {
    expect(parseImgHtml('<img src="方案.assets/a.png" style="width:240px">')?.width).toBe(240);
  });

  it('align=right', () => {
    expect(parseImgHtml('<p align="right"><img src="x.assets/a.png"></p>')?.align).toBe('right');
  });

  it('远程 / 绝对 / .. 段越界 src → null（本期只管本地图）', () => {
    expect(parseImgHtml('<img src="https://x.com/a.png">')).toBeNull();
    expect(parseImgHtml('<img src="/abs/a.png">')).toBeNull();
    expect(parseImgHtml('<img src="../secret.png">')).toBeNull();
    expect(parseImgHtml('<img src="x.assets/../../etc.png">')).toBeNull();
  });

  it('文件名里偶含 .. 不误拒（a..b.png 是合法本地引用）', () => {
    expect(parseImgHtml('<img src="x.assets/a..b.png">')?.src).toBe('x.assets/a..b.png');
  });

  it('非 img 的 HTML → null', () => {
    expect(parseImgHtml('<div>hi</div>')).toBeNull();
  });

  it('无 src 的 img → null', () => {
    expect(parseImgHtml('<img width="100">')).toBeNull();
  });
});

/**
 * buildImageSource —— 工具条改大小/对齐时把 {src,width,align} 写回源码（§五）。承重：
 * 默认形态（无大小、左对齐）落纯 markdown `![]()`（哪都认、可移植）；否则落单行 HTML（外部优雅降级）。
 */
describe('buildImageSource', () => {
  it('无大小 + 左对齐 → 纯 markdown ![]()（最可移植）', () => {
    expect(buildImageSource('x.assets/a.png', null, 'left')).toBe('![](x.assets/a.png)');
  });

  it('有大小 + 左对齐 → 单行 <img width>（不包 <p>）', () => {
    expect(buildImageSource('x.assets/a.png', 320, 'left')).toBe(
      '<img src="x.assets/a.png" width="320">',
    );
  });

  it('居中 → 外包单行 <p align="center">', () => {
    expect(buildImageSource('x.assets/a.png', 320, 'center')).toBe(
      '<p align="center"><img src="x.assets/a.png" width="320"></p>',
    );
  });

  it('右对齐 + 无大小 → <p align="right"> 包裸 <img>', () => {
    expect(buildImageSource('x.assets/a.png', null, 'right')).toBe(
      '<p align="right"><img src="x.assets/a.png"></p>',
    );
  });

  it('alt 保留（纯 markdown 与 <img> 两路）', () => {
    expect(buildImageSource('x.assets/a.png', null, 'left', '配图')).toBe('![配图](x.assets/a.png)');
    expect(buildImageSource('x.assets/a.png', 200, 'left', '配图')).toBe(
      '<img src="x.assets/a.png" width="200" alt="配图">',
    );
  });

  it('与 parseImgHtml 往返一致', () => {
    for (const [w, a] of [
      [200, 'center'],
      [null, 'right'],
      [360, 'left'],
    ] as const) {
      const html = buildImageSource('x.assets/a.png', w, a);
      if (html.startsWith('![')) continue; // 纯 markdown 形态不经 parseImgHtml
      expect(parseImgHtml(html)).toEqual({ src: 'x.assets/a.png', width: w, align: a });
    }
  });
});
