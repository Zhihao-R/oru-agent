import { describe, expect, it } from 'vitest';
import { renderInline } from '@/components/editor/inlineMarkdown';

/**
 * renderInline：单元格 markdown 片段 → 已转义 HTML，走 @lezer/markdown（含 GFM 删除线）。
 * 输出经 innerHTML 注入，故"未识别的一切"必须当字面文本转义（防 XSS）。
 */
describe('renderInline：行内元素', () => {
  it('粗体 → <strong>', () => {
    expect(renderInline('**联网**')).toBe('<strong>联网</strong>');
  });

  it('斜体 → <em>', () => {
    expect(renderInline('*斜*')).toBe('<em>斜</em>');
  });

  it('行内代码 → <code>', () => {
    expect(renderInline('`code`')).toBe('<code>code</code>');
  });

  it('删除线 → <del>（GFM）', () => {
    expect(renderInline('~~删~~')).toBe('<del>删</del>');
  });

  it('链接 → <a href>（带 target=_blank + noopener，避免编辑器整页导航）', () => {
    expect(renderInline('[文字](http://u)')).toBe(
      '<a href="http://u" target="_blank" rel="noopener noreferrer">文字</a>',
    );
  });

  it('emoji 原样透传', () => {
    expect(renderInline('能力 😀')).toBe('能力 😀');
  });
});

describe('renderInline：转义与嵌套', () => {
  it('HTML 特殊字符转义', () => {
    expect(renderInline('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('code 内的 * 不被当强调（lezer 天然）', () => {
    expect(renderInline('`a*b*c`')).toBe('<code>a*b*c</code>');
  });

  it('code 内容也转义', () => {
    expect(renderInline('`<x>`')).toBe('<code>&lt;x&gt;</code>');
  });

  it('粗体里嵌行内代码', () => {
    expect(renderInline('**a `c` b**')).toBe('<strong>a <code>c</code> b</strong>');
  });

  it('链接文字可含嵌套粗体', () => {
    expect(renderInline('[**b**](http://u)')).toBe(
      '<a href="http://u" target="_blank" rel="noopener noreferrer"><strong>b</strong></a>',
    );
  });

  it('转义竖线 \\| 渲染为字面 |', () => {
    expect(renderInline('x \\| y')).toBe('x | y');
  });
});

describe('renderInline：安全', () => {
  it('裸 HTML 标签当字面文本转义，不注入', () => {
    expect(renderInline('<img src=x onerror=alert(1)>')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;',
    );
  });

  it('链接 URL 里的 & 在属性内转义', () => {
    expect(renderInline('[t](http://u?a=1&b=2)')).toBe(
      '<a href="http://u?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">t</a>',
    );
  });

  it('不安全 scheme（javascript:）的链接降级为纯文本、不出 href', () => {
    expect(renderInline('[x](javascript:alert(1))')).toBe('x');
  });
});
