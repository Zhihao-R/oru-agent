/**
 * DeckModel 纯函数单测（§七）：切页放宽 / 画布解析 / 诚实边界。
 */
import { describe, expect, it } from 'vitest';
import {
  segmentSlides,
  segmentSlidesWithRanges,
  getCanvas,
  parseDeckSizeContent,
  DEFAULT_CANVAS,
} from '../../electron/main/deck/deckModel';

describe('segmentSlides — 标签放宽到 section/div/article', () => {
  it('section.slide（含其他 class / 属性混排）', () => {
    const html =
      '<div class="deck"><section class="slide" data-title="A">1</section>' +
      '<section class="slide center tc">2</section></div>';
    expect(segmentSlides(html).length).toBe(2);
  });

  it('div.slide 与 article.slide 都切得出', () => {
    expect(segmentSlides('<div class="slide">a</div><div class="slide">b</div>').length).toBe(2);
    expect(segmentSlides('<article class="x slide">a</article><article class="slide">b</article>').length).toBe(2);
  });

  it('父容器 class=deck（非 slide）不会被误当页', () => {
    const html = '<div class="deck"><section class="slide">only</section></div>';
    expect(segmentSlides(html).length).toBe(1);
  });

  it('0 页：无 class=slide 块', () => {
    expect(segmentSlides('<div class="page">x</div>')).toEqual([]);
    expect(segmentSlides('')).toEqual([]);
  });

  it('class 必须是整 token slide——my-slide / slide-content 不算页（与 CSS .slide 口径一致）', () => {
    // 否则 main 侧多切、渲染端 .slide 不认 → 两侧 pageIndex 错位
    expect(segmentSlides('<div class="my-slide">x</div>')).toEqual([]);
    expect(segmentSlides('<div class="slide-content">x</div>')).toEqual([]);
    expect(segmentSlides('<div class="hero-slide">x</div>')).toEqual([]);
    // 真 slide token（含多 class、前后位置）照常切
    expect(segmentSlides('<div class="my-slide">a</div><section class="slide">b</section>').length).toBe(1);
    expect(segmentSlides('<section class="center tc slide">b</section>').length).toBe(1);
    expect(segmentSlides('<section class="a slide b">b</section>').length).toBe(1);
  });

  it('逐项对齐渲染端 CSS .slide：任意标签 / 标签名大小写不敏感 / class 值大小写敏感', () => {
    // 任意标签——CSS .slide 不挑标签，main 也不能只认 section/div/article
    expect(segmentSlides('<main class="slide">a</main>').length).toBe(1);
    expect(segmentSlides('<figure class="slide">a</figure>').length).toBe(1);
    expect(segmentSlides('<header class="slide">a</header>').length).toBe(1);
    // 标签名 / class 属性名大小写不敏感（HTML 语义），反向引用闭合也跟着不敏感
    expect(segmentSlides('<Section class="slide">a</Section>').length).toBe(1);
    expect(segmentSlides('<div CLASS="slide">a</div>').length).toBe(1);
    // class 值大小写敏感（CSS .slide 不认 SLIDE/Slide）——否则 main 多切、渲染端不认
    expect(segmentSlides('<div class="SLIDE">a</div>')).toEqual([]);
    expect(segmentSlides('<div class="Slide">a</div>')).toEqual([]);
  });

  it('无引号 class 值也切得出（HTML5 合法、渲染端 .slide 认）—— L3', () => {
    // 渲染端 querySelectorAll('.slide') 认无引号属性值，main 也必须认，否则漏切、页号错位
    expect(segmentSlides('<div class=slide>a</div>').length).toBe(1);
    expect(segmentSlides('<section class=slide>a</section><section class=slide>b</section>').length).toBe(2);
    // 后接其他属性
    expect(segmentSlides('<div class=slide data-x="1">a</div>').length).toBe(1);
    // 无引号值是单 token：slide-content / myslide / Slide 都不算页（与渲染端口径一致）
    expect(segmentSlides('<div class=slide-content>a</div>')).toEqual([]);
    expect(segmentSlides('<div class=myslide>a</div>')).toEqual([]);
    expect(segmentSlides('<div class=Slide>a</div>')).toEqual([]);
    // 引号与无引号混排
    expect(segmentSlides('<div class=slide>a</div><div class="slide">b</div>').length).toBe(2);
  });

  it('开标签按引号感知消费：属性值里有 > 不会漏切整页', () => {
    // aria-label 里的箭头 > 排在 class 前——[^>]* 会在引号内的 > 截断、漏掉这页；引号感知不会
    const html = '<div aria-label="下一步 > 完成" class="slide">A</div><div class="slide">B</div>';
    expect(segmentSlides(html).length).toBe(2);
    // > 在 class 之后的属性里
    expect(segmentSlides('<section class="slide" data-t="a>b">x</section>').length).toBe(1);
  });

  it('class 必须是真属性名（前置空白）——data-class="slide" 不算页（DOM .slide 也不认）', () => {
    expect(segmentSlides('<div data-class="slide">a</div>')).toEqual([]);
    expect(segmentSlides('<div data-x="1" foo-class="slide">a</div>')).toEqual([]);
    // 真 class 属性照常
    expect(segmentSlides('<div data-class="x" class="slide">a</div>').length).toBe(1);
  });

  it('诚实边界：同名标签嵌套被非贪婪提前闭合（切错，走"认不出"路径）', () => {
    // <div class="slide"> 里又有裸 <div>：</div> 会先闭合内层 → 切出的第一页是残段
    const seg = segmentSlides('<div class="slide"><div>inner</div></div>');
    expect(seg.length).toBe(1);
    expect(seg[0]).toBe('<div class="slide"><div>inner</div>'); // 提前闭合，未含外层 </div>
  });

  it('诚实边界：异标签内层也带 class=slide 会被误当独立页', () => {
    const seg = segmentSlides('<section class="slide"><div class="slide">x</div></section>');
    // 内层 div.slide 先被非贪婪匹配 → 至少切出它（不是干净的 1 页）
    expect(seg.length).toBeGreaterThanOrEqual(1);
  });
});

describe('segmentSlidesWithRanges — 保留字节区间', () => {
  it('range 切片与原文一致、单调递增', () => {
    const html = 'XX<section class="slide">a</section>YY<section class="slide">b</section>ZZ';
    const ranges = segmentSlidesWithRanges(html);
    expect(ranges.length).toBe(2);
    expect(html.slice(ranges[0].start, ranges[0].end)).toBe(ranges[0].html);
    expect(html.slice(ranges[1].start, ranges[1].end)).toBe(ranges[1].html);
    expect(ranges[1].start).toBeGreaterThan(ranges[0].end);
  });

  it('div.slide 也算得出区间（reorder 重排 div.slide deck 靠它 splice）', () => {
    const html = '<div class="deck"><div class="slide">a</div>\n<div class="slide">b</div></div>';
    const ranges = segmentSlidesWithRanges(html);
    expect(ranges.length).toBe(2);
    expect(ranges[0].html).toBe('<div class="slide">a</div>');
    // 首页起、末页止之间 splice 区间正确（重排只换中间段、保留外层 deck 包裹）
    expect(html.slice(0, ranges[0].start)).toBe('<div class="deck">');
    expect(html.slice(ranges[1].end)).toBe('</div>');
  });
});

describe('parseDeckSizeContent / getCanvas', () => {
  it('正常 WxH（x / X / ×）', () => {
    expect(parseDeckSizeContent('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(parseDeckSizeContent('1024X768')).toEqual({ width: 1024, height: 768 });
    expect(parseDeckSizeContent(' 1080×1920 ')).toEqual({ width: 1080, height: 1920 });
  });

  it('非法值 → null', () => {
    expect(parseDeckSizeContent('abc')).toBeNull();
    expect(parseDeckSizeContent('0x0')).toBeNull();
    expect(parseDeckSizeContent('-1x100')).toBeNull();
    expect(parseDeckSizeContent('1920')).toBeNull();
    expect(parseDeckSizeContent('')).toBeNull();
  });

  it('getCanvas：读 meta；缺失 / 非法退 DEFAULT_CANVAS', () => {
    const ok =
      '<html><head><meta name="oru-deck-size" content="1024x768"></head><body></body></html>';
    expect(getCanvas(ok)).toEqual({ width: 1024, height: 768 });
    expect(getCanvas('<html><head></head></html>')).toEqual(DEFAULT_CANVAS);
    const bad = '<head><meta name="oru-deck-size" content="garbage"></head>';
    expect(getCanvas(bad)).toEqual(DEFAULT_CANVAS);
  });

  it('getCanvas：meta 属性顺序无关（content 在 name 前也认）', () => {
    const html = '<meta content="800x600" name="oru-deck-size">';
    expect(getCanvas(html)).toEqual({ width: 800, height: 600 });
  });
});
