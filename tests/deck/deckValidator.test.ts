/**
 * Deck 校验器纯逻辑 + 结构早返单测（不渲染——渲染路径的溢出/空白/裂图归 detect smoke）。
 *
 * extractImageRefs（去 querystring / 多引用 / 无引用）/ describeOverflow / 结构判定（空 html、
 * 0 slide → page:null，且**早返、不触发渲染**，所以能在纯 node 下跑）。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  extractImageRefs,
  describeOverflow,
  hasUnrecognizedContent,
  deckValidator,
} from '../../electron/main/deck/deckValidator';
import { segmentSlides } from '../../electron/main/deck/deckModel';

describe('hasUnrecognizedContent — 部分认不出兜底（§四）', () => {
  it('slide 外有大段可见文字 → true（混合 deck）', () => {
    const html =
      '<body><div class="deck"><section class="slide">P1</section></div>' +
      '<div class="weird">这是一段没有被识别为页的额外内容，本该是一页但结构不符合约定，应当被检测并如实告知</div></body>';
    expect(hasUnrecognizedContent(html, segmentSlides(html))).toBe(true);
  });

  it('slide 外只有装饰 chrome（进度条 / 脚本，无可见文字）→ false（不误报正常 deck）', () => {
    const html =
      '<body><div class="deck"><section class="slide">P1</section></div>' +
      '<div class="progress-bar"><span></span></div><script>console.log(1)</script></body>';
    expect(hasUnrecognizedContent(html, segmentSlides(html))).toBe(false);
  });

  it('全部内容都在 slide 内 → false', () => {
    const html = '<body><section class="slide"><h1>标题</h1><p>正文内容很多很多</p></section></body>';
    expect(hasUnrecognizedContent(html, segmentSlides(html))).toBe(false);
  });

  it('两页 HTML 完全相同（同模板空页）不误报——split/join 抹掉全部出现', () => {
    const page = '<section class="slide"><h1>完全一样的页面内容标题</h1></section>';
    const html = `<body>${page}${page}</body>`;
    expect(hasUnrecognizedContent(html, segmentSlides(html))).toBe(false);
  });
});

describe('extractImageRefs', () => {
  it('抽出 images/ 引用，去重', () => {
    const html = `<img src="images/a.png"><img src='images/b.jpg'><img src="images/a.png">`;
    expect(extractImageRefs(html).sort()).toEqual(['images/a.png', 'images/b.jpg']);
  });

  it('去掉 querystring / fragment', () => {
    const html = `<img src="images/hero.png?v=2"><img src="images/x.svg#frag">`;
    expect(extractImageRefs(html).sort()).toEqual(['images/hero.png', 'images/x.svg']);
  });

  it('href 形态也抽（背景 / link）；不抽远程 http(s) 与非 images/ 路径', () => {
    const html = `<a href="images/deck.pdf"></a><img src="https://x.com/a.png"><img src="./local.png">`;
    expect(extractImageRefs(html)).toEqual(['images/deck.pdf']);
  });

  it('无引用返回空数组', () => {
    expect(extractImageRefs('<section class="slide">纯文字</section>')).toEqual([]);
  });
});

describe('describeOverflow', () => {
  it('只报超出的维度', () => {
    expect(describeOverflow({ x: 0, y: 120 })).toBe('竖向溢出 120px');
    expect(describeOverflow({ x: 48, y: 0 })).toBe('横向溢出 48px');
    expect(describeOverflow({ x: 30, y: 120 })).toBe('竖向溢出 120px、横向溢出 30px');
  });

  it('四舍五入像素', () => {
    expect(describeOverflow({ x: 0, y: 12.6 })).toBe('竖向溢出 13px');
  });
});

describe('结构判定（早返、不渲染）', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), 'deckvalidator-'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('index.html 缺失 → page:null structure', async () => {
    const d = join(dir, 'missing');
    await fs.mkdir(d, { recursive: true });
    const errs = await deckValidator(d);
    expect(errs).toEqual([{ page: null, kind: 'structure', message: 'index.html 缺失或为空' }]);
  });

  it('index.html 为空（仅空白）→ page:null structure', async () => {
    const d = join(dir, 'empty');
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(join(d, 'index.html'), '   \n  ', 'utf-8');
    const errs = await deckValidator(d);
    expect(errs[0]).toMatchObject({ page: null, kind: 'structure' });
  });

  it('分不出任何 slide → page:null structure，就此返回（不进逐页渲染）', async () => {
    const d = join(dir, 'noslide');
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(join(d, 'index.html'), '<html><body><div>没有 section.slide</div></body></html>', 'utf-8');
    const errs = await deckValidator(d);
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatchObject({ page: null, kind: 'structure' });
    expect(errs[0].message).toContain('未识别出任何分页');
  });
});
