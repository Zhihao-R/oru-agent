import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownDoc } from '@/lib/markdownRender';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';

/**
 * MarkdownDoc 是聊天与导出共用的单一渲染源（技术方案 §三）：插件栈/components/headingIds 一处定义，
 * 导出端复用以保证「所见即所得」、无第二套实现漂移。
 */
describe('MarkdownDoc', () => {
  it('产出 .oru-chat-md 容器与书本风结构（标题/表格/任务清单）', () => {
    const html = renderToStaticMarkup(
      <MarkdownDoc content={'# 标题\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n- [x] 完成'} />,
    );
    expect(html).toContain('class="oru-chat-md"');
    expect(html).toContain('<h1');
    expect(html).toContain('<table>');
    expect(html).toContain('type="checkbox"');
  });

  it('标题补 id，供文档内锚点与导出目录链接', () => {
    const html = renderToStaticMarkup(<MarkdownDoc content={'## 小节标题'} />);
    expect(html).toMatch(/<h2[^>]*id="小节标题"/);
  });

  it('代码块经 rehypeHighlight 着色（hljs span）', () => {
    const html = renderToStaticMarkup(
      <MarkdownDoc content={'```ts\nconst x = 1;\n```'} />,
    );
    expect(html).toContain('class="hljs');
  });

  it('块级公式经 rehypeKatex 预渲染为静态 KaTeX + MathML（零运行时）', () => {
    const html = renderToStaticMarkup(<MarkdownDoc content={'$$a^2 + b^2$$'} />);
    expect(html).toContain('class="katex"');
    expect(html).toContain('<math');
    expect(html).not.toContain('<script');
  });

  it('单 $ 不当公式（singleDollarTextMath:false，与聊天一致）', () => {
    const html = renderToStaticMarkup(<MarkdownDoc content={'价格 $100 到 $200'} />);
    expect(html).not.toContain('class="katex"');
  });

  it('有 docIdentity 时相对图引用改写成 oru-doc-img:// URL', () => {
    const html = renderToStaticMarkup(
      <MarkdownDoc
        content={'![图](报告.assets/p.png)'}
        docIdentity={{ projectId: 'p1', docPath: 'report.md' }}
      />,
    );
    expect(html).toContain('src="oru-doc-img://local/p1/report.md/');
    expect(html).not.toContain('src="报告.assets/p.png"');
  });

  it('非 ASCII 图引用：产出的 oru-doc-img URL 能往返解回原始 ref（不双重编码）', async () => {
    const { parseDocImageUrl } = await import('../../electron/main/fs/docImageProtocol');
    const html = renderToStaticMarkup(
      <MarkdownDoc
        content={'![红点](样本.assets/pic.png)'}
        docIdentity={{ projectId: 'p1', docPath: '样本.md' }}
      />,
    );
    const url = html.match(/oru-doc-img:\/\/[^"]+/)?.[0];
    expect(url).toBeTruthy();
    // react-markdown 会先对 src 做一次 percent 编码；docImageUrl 不能在其上再编码，否则主进程解一次
    // 仍是 %E6…、找不到图。判据：解析回来必须是原始未编码的 ref。
    const parsed = parseDocImageUrl(url!);
    expect(parsed).toEqual({ projectId: 'p1', docPath: '样本.md', imageRef: '样本.assets/pic.png' });
  });

  it('无 docIdentity 时图引用保持原样（聊天路径不改写）', () => {
    const html = renderToStaticMarkup(<MarkdownDoc content={'![x](https://e.com/a.png)'} />);
    expect(html).toContain('src="https://e.com/a.png"');
  });

  it('外链不被当本地图改写（即便有 docIdentity）', () => {
    const html = renderToStaticMarkup(
      <MarkdownDoc
        content={'![a](https://e.com/a.png)'}
        docIdentity={{ projectId: 'p1', docPath: 'r.md' }}
      />,
    );
    expect(html).toContain('src="https://e.com/a.png"');
    expect(html).not.toContain('oru-doc-img');
  });

  it('导出物不外泄 node="[object Object]" 垃圾属性（a/table/img/input 都剥 node）', () => {
    const html = renderToStaticMarkup(
      <MarkdownDoc
        content={'[L](https://e.com)\n\n| a |\n| - |\n| 1 |\n\n- [x] x\n\n![i](r.assets/p.png)'}
        docIdentity={{ projectId: 'p1', docPath: 'r.md' }}
      />,
    );
    expect(html).not.toContain('node=');
  });

  it('ChatMarkdown 委托 MarkdownDoc：同一 md 输出结构一致', () => {
    const md = '# H\n\n正文 **粗**\n\n```js\nfoo();\n```';
    const viaChat = renderToStaticMarkup(<ChatMarkdown source={md} />);
    const viaDoc = renderToStaticMarkup(<MarkdownDoc content={md} />);
    expect(viaChat).toBe(viaDoc);
  });
});
