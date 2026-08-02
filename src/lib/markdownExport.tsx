import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownDoc } from '@/lib/markdownRender';
import { type DocIdentity } from '@/lib/docImageUrl';
import { baseExportCss, bookExportCss, paperExportCss } from '@/lib/exportTheme';

/**
 * 渲染端导出 HTML 组装（技术方案 §四 / §六.1）——导出 HTML 的真相源活在前端：
 * renderToStaticMarkup 出正文（math/代码已预渲染、零运行时 JS），套上内联的 base/主题 CSS，
 * 得到一份 HTML 文档。vendored 的 katex CSS（含字体）由主进程在 </head> 前注入（与字体同处读 node_modules，
 * 见 export/katexAssets.ts）；HTML 出口再内联本地图片，PDF 出口经离屏渲染。
 *
 * 主题三层 base + (book|paper) 见 exportTheme.ts。paperMode 仅 PDF 有意义（HTML 出口恒 book）；
 * 物理页几何（A4/页边距/页码）归主进程 printToPDF。
 */
export function renderMarkdownExportHtml(
  content: string,
  opts: { paperMode: boolean; docIdentity: DocIdentity | null; title?: string },
): string {
  const body = renderToStaticMarkup(
    <MarkdownDoc content={content} docIdentity={opts.docIdentity} />,
  );
  const themeCss = opts.paperMode ? paperExportCss : bookExportCss;
  const title = escapeHtml(opts.title ?? '导出文档');
  return [
    '<!DOCTYPE html>',
    '<html>',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${title}</title>`,
    `<style>${baseExportCss}</style>`,
    `<style>${themeCss}</style>`,
    '</head>',
    `<body>${body}</body>`,
    '</html>',
  ].join('\n');
}

/** 空 / 纯空白文档不可导出（PRD 护栏：不产出空白文件，渲染端前置拦截、不发请求）。 */
export function isExportableMarkdown(content: string): boolean {
  return content.trim().length > 0;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
