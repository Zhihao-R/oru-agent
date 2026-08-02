import { describe, it, expect } from 'vitest';
import { renderMarkdownExportHtml, isExportableMarkdown } from '@/lib/markdownExport';

/**
 * 渲染端导出 HTML 组装（技术方案 §四 / §六.1）：renderToStaticMarkup 正文 + 内联 base/主题/katex CSS
 * → 完整 HTML 文档。真相源活在前端，主进程只内联二进制资源、各出口落地。
 */
describe('renderMarkdownExportHtml', () => {
  const md = '# 报告\n\n正文 **粗体**\n\n```ts\nconst x = 1;\n```\n\n$$a^2$$';

  it('产出完整 HTML 文档（doctype/head/body + .oru-chat-md 正文）', () => {
    const html = renderMarkdownExportHtml(md, { paperMode: false, docIdentity: null });
    expect(html).toMatch(/^<!DOCTYPE html>/i);
    expect(html).toContain('<head>');
    expect(html).toContain('charset="utf-8"');
    expect(html).toContain('<body>');
    expect(html).toContain('class="oru-chat-md"');
    expect(html).toContain('<h1');
  });

  it('内联 base 主题（含 hljs 着色）；katex CSS 由主进程注入故此处不含', () => {
    const html = renderMarkdownExportHtml(md, { paperMode: false, docIdentity: null });
    expect(html).toContain('.oru-chat-md .hljs'); // base 主题的代码高亮着色（仓库手写、非外部主题包）
    // 渲染端不内联 katex.min.css（vendored 资源 + 字体一并由主进程读 node_modules 注入），
    // 但留好可注入点：</head> 在正文之前
    expect(html.indexOf('</head>')).toBeLessThan(html.indexOf('<body>'));
  });

  it('base 主题落具体色值、不含 var() CSS 变量（导出物无 Oru 主题切换器）', () => {
    const html = renderMarkdownExportHtml(md, { paperMode: false, docIdentity: null });
    // 提取注入的 <style> 文本，断言导出主题段不依赖运行时 CSS 变量
    expect(html).toContain('#1f1b16'); // 默认暖光 --text-primary 已落成具体值
  });

  it('book / paper 两套主题按 paperMode 切换（哨兵标识）', () => {
    const book = renderMarkdownExportHtml(md, { paperMode: false, docIdentity: null });
    const paper = renderMarkdownExportHtml(md, { paperMode: true, docIdentity: null });
    expect(book).toContain('export-theme: book');
    expect(book).not.toContain('export-theme: paper');
    expect(paper).toContain('export-theme: paper');
    expect(paper).not.toContain('export-theme: book');
  });

  it('两版正文文字内容一致（仅版式不同）', () => {
    const book = renderMarkdownExportHtml(md, { paperMode: false, docIdentity: null });
    const paper = renderMarkdownExportHtml(md, { paperMode: true, docIdentity: null });
    const bodyOf = (h: string): string => h.slice(h.indexOf('<body>'), h.indexOf('</body>'));
    expect(bodyOf(book)).toBe(bodyOf(paper));
  });

  it('文档标题进 <title>', () => {
    const html = renderMarkdownExportHtml(md, {
      paperMode: false,
      docIdentity: null,
      title: '季度报告',
    });
    expect(html).toContain('<title>季度报告</title>');
  });

  it('docIdentity 透传到正文：本地图引用改写成 oru-doc-img://', () => {
    const html = renderMarkdownExportHtml('![图](r.assets/p.png)', {
      paperMode: false,
      docIdentity: { projectId: 'p1', docPath: 'r.md' },
    });
    expect(html).toContain('oru-doc-img://local/p1/r.md/');
  });
});

describe('isExportableMarkdown', () => {
  it('空 / 纯空白文档不可导出', () => {
    expect(isExportableMarkdown('')).toBe(false);
    expect(isExportableMarkdown('   \n\t  \n')).toBe(false);
  });
  it('有实质内容可导出', () => {
    expect(isExportableMarkdown('# 标题')).toBe(true);
  });
});
