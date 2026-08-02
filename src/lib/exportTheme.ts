/**
 * 导出主题 CSS —— app 自有的书本风样式，以 TS 字符串常量提供（同 deckFrame 注入资源的做法：
 * 注入式资源走模板串，不依赖 `?raw` 这类构建特性，渲染/测试环境一致）。
 *
 * 分三层（避免 paper 重复 base，加第三套主题零成本）：
 *   baseExportCss —— .oru-chat-md 正文规则 + hljs 着色，是与屏幕端视觉一致的唯一来源
 *   bookExportCss / paperExportCss —— 页面级风格，按 paperMode 二选一
 *
 * vendored 的 katex CSS / 字体不在这里——它们是 node_modules 资源，由主进程读盘内联（见
 * electron/main/export/katexAssets.ts），与 katex 字体同处，渲染端不碰。
 */

/*
 * base —— 与屏幕端 src/index.css 的 .oru-chat-md 块（:407 起，含 :566 起 hljs 着色）是一处需手动
 * 同步的视觉耦合：改其一就改这里。两处分开，因导出物没有 Oru 的主题切换器——这里把 src/index.css 用的
 * CSS 变量（--text-primary 等）全部落成「默认暖光主题」具体色值（src/index.css :11-23），var() 不可用。
 * 代码高亮着色是仓库手写（非外部 highlight.js 主题包），故必须连同正文规则一起内联进导出物。
 */
export const baseExportCss = `
.oru-chat-md {
  color: #1f1b16;
  font-size: 15px;
  line-height: 1.75;
  word-wrap: break-word;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei',
    Roboto, Helvetica, Arial, sans-serif;
}
.oru-chat-md > *:first-child { margin-top: 0; }
.oru-chat-md > *:last-child { margin-bottom: 0; }

.oru-chat-md h1 {
  font-family: 'New York', 'Source Serif Pro', Georgia, 'Songti SC', serif;
  font-size: 1.5em;
  font-weight: 600;
  margin: 1.4em 0 0.5em;
  line-height: 1.3;
  letter-spacing: -0.01em;
  color: #1f1b16;
}
.oru-chat-md h2 {
  font-family: 'New York', 'Source Serif Pro', Georgia, 'Songti SC', serif;
  font-size: 1.25em;
  font-weight: 600;
  margin: 1.3em 0 0.4em;
  line-height: 1.35;
  color: #1f1b16;
}
.oru-chat-md h3 { font-size: 1.08em; font-weight: 600; margin: 1.1em 0 0.3em; color: #1f1b16; }
.oru-chat-md h4, .oru-chat-md h5, .oru-chat-md h6 {
  font-size: 1em; font-weight: 600; margin: 0.9em 0 0.3em; color: #1f1b16;
}

.oru-chat-md p { margin: 0.7em 0; }
.oru-chat-md strong { font-weight: 600; color: #1f1b16; }
.oru-chat-md em { font-style: italic; }
.oru-chat-md del { color: rgba(31, 27, 22, 0.42); }

.oru-chat-md a {
  color: #c45a2b;
  text-decoration: underline;
  text-decoration-color: rgba(196, 90, 43, 0.12);
  text-underline-offset: 2px;
}

.oru-chat-md ul, .oru-chat-md ol { margin: 0.6em 0; padding-left: 1.5em; }
.oru-chat-md ul { list-style: disc; }
.oru-chat-md ul ul { list-style: circle; }
.oru-chat-md ul ul ul { list-style: square; }
.oru-chat-md ol { list-style: decimal; }
.oru-chat-md li.task-list-item { list-style: none; }
.oru-chat-md li { margin: 0.3em 0; }
.oru-chat-md li > p { margin: 0.2em 0; }
.oru-chat-md ul li::marker, .oru-chat-md ol li::marker { color: rgba(31, 27, 22, 0.42); }

.oru-chat-md blockquote {
  margin: 0.9em 0;
  padding: 0.1em 0 0.1em 0.9em;
  border-left: 2px solid rgba(31, 27, 22, 0.08);
  color: rgba(31, 27, 22, 0.68);
  font-style: italic;
}

.oru-chat-md code {
  font-family: 'SF Mono', ui-monospace, Menlo, Monaco, monospace;
  font-size: 0.88em;
  padding: 0.1em 0.35em;
  background: #f3f1ec;
  border-radius: 3px;
  color: #1f1b16;
}
.oru-chat-md pre {
  margin: 0.9em 0;
  padding: 12px 14px;
  background: #f3f1ec;
  border-radius: 6px;
  overflow-x: auto;
  font-size: 12.5px;
  line-height: 1.55;
}
.oru-chat-md pre code { padding: 0; background: transparent; border-radius: 0; font-size: inherit; }

.oru-chat-md hr { margin: 1.6em 0; border: none; border-top: 1px solid rgba(31, 27, 22, 0.08); }

.oru-chat-md-table-wrap { overflow-x: auto; }
.oru-chat-md table { margin: 0.9em 0; border-collapse: collapse; font-size: 13.5px; }
.oru-chat-md th, .oru-chat-md td {
  padding: 6px 10px;
  border-bottom: 1px solid rgba(31, 27, 22, 0.08);
  text-align: left;
}
.oru-chat-md th { font-weight: 600; color: #1f1b16; }

.oru-chat-md img { max-width: 100%; border-radius: 4px; }
.oru-chat-md input[type='checkbox'] { margin-right: 0.5em; accent-color: #c45a2b; }

.oru-chat-md .footnotes {
  margin-top: 1.4em;
  padding-top: 0.8em;
  border-top: 1px solid rgba(31, 27, 22, 0.08);
  font-size: 0.86em;
  color: rgba(31, 27, 22, 0.68);
}
.oru-chat-md .footnotes > h2 {
  position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden;
  clip: rect(0, 0, 0, 0); white-space: nowrap;
}
.oru-chat-md sup a { text-decoration: none; }

.oru-chat-md .katex-display { margin: 0.9em 0; }

.oru-chat-md .hljs { color: #1f1b16; background: transparent; }
.oru-chat-md .hljs-comment, .oru-chat-md .hljs-quote { color: rgba(31, 27, 22, 0.42); font-style: italic; }
.oru-chat-md .hljs-keyword, .oru-chat-md .hljs-selector-tag, .oru-chat-md .hljs-built_in,
.oru-chat-md .hljs-name, .oru-chat-md .hljs-tag { color: #c45a2b; }
.oru-chat-md .hljs-string, .oru-chat-md .hljs-title, .oru-chat-md .hljs-section,
.oru-chat-md .hljs-attribute, .oru-chat-md .hljs-literal, .oru-chat-md .hljs-template-tag,
.oru-chat-md .hljs-template-variable, .oru-chat-md .hljs-type, .oru-chat-md .hljs-addition { color: #3a7d44; }
.oru-chat-md .hljs-number, .oru-chat-md .hljs-symbol, .oru-chat-md .hljs-bullet,
.oru-chat-md .hljs-link, .oru-chat-md .hljs-meta, .oru-chat-md .hljs-deletion { color: #c45a2b; }
.oru-chat-md .hljs-emphasis { font-style: italic; }
.oru-chat-md .hljs-strong { font-weight: 600; }
`;

/*
 * book —— 书本风（默认）。延续屏幕上看到的连续排版。
 * 屏幕（双击打开的 HTML）：暖纸底色 + 居中可读栏宽；打印（PDF 默认版）：白底无纸张装饰、内容连续流。
 * 物理页几何（A4 + 页边距）由主进程 printToPDF 决定（与 pageSize 同处），不在 CSS @page 里。
 */
export const bookExportCss = `
/* export-theme: book */
html, body { margin: 0; padding: 0; }
body { background: #faf9f7; color: #1f1b16; }

@media screen {
  body { padding: 48px 24px; }
  .oru-chat-md { max-width: 760px; margin: 0 auto; }
}

@media print {
  body { background: #ffffff; }
  .oru-chat-md { max-width: none; }
  .oru-chat-md-table-wrap { overflow-x: visible; }
}
`;

/*
 * paper —— A4 论文式纸张排版（PDF「纸张版」开关打开时）。通篇衬线、两端对齐、章节留白、白底。
 * 物理页几何（A4 + 规整页边距 + 页码）由主进程 printToPDF 决定（margins / footerTemplate），
 * CSS 只管观感与分页行为。Markdown 表格无题注数据源，故不凭空生成题注，只把表格作正式化排版。
 */
export const paperExportCss = `
/* export-theme: paper */
html, body { margin: 0; padding: 0; }
body { background: #ffffff; color: #1f1b16; }

.oru-chat-md {
  font-family: 'New York', 'Source Serif Pro', Georgia, 'Songti SC', serif;
  text-align: justify;
  hyphens: auto;
}
.oru-chat-md h3, .oru-chat-md h4, .oru-chat-md h5, .oru-chat-md h6 {
  font-family: 'New York', 'Source Serif Pro', Georgia, 'Songti SC', serif;
}

.oru-chat-md h1 { margin-top: 1.8em; }
.oru-chat-md h2 { margin-top: 1.6em; padding-top: 0.2em; }
.oru-chat-md h1, .oru-chat-md h2, .oru-chat-md h3 { break-after: avoid; }

.oru-chat-md p { orphans: 3; widows: 3; }
.oru-chat-md pre, .oru-chat-md blockquote, .oru-chat-md table, .oru-chat-md img { break-inside: avoid; }

.oru-chat-md-table-wrap { overflow-x: visible; }
.oru-chat-md table { width: 100%; border-top: 1.5px solid #1f1b16; border-bottom: 1.5px solid #1f1b16; }
.oru-chat-md thead th { border-bottom: 1px solid #1f1b16; }
.oru-chat-md td, .oru-chat-md th { border-bottom: none; }
.oru-chat-md tbody tr:not(:last-child) td { border-bottom: 0.5px solid rgba(31, 27, 22, 0.12); }
`;
