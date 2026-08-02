import { parser as baseParser, Strikethrough } from '@lezer/markdown';
import type { SyntaxNode } from '@lezer/common';

/**
 * 单元格 markdown 片段 → 已转义 HTML，走 @lezer/markdown（含 GFM 删除线）。纯函数。
 * 复用 lezer 而非手写正则：格内本就是合法 markdown，树天然嵌套，一举避开
 * code-内-`*`、嵌套错位、占位哨兵等手写正则的坑（与既有装饰层同源）。
 * 输出经 innerHTML 注入——"未识别的一切"（裸 HTML、未知节点）一律当字面文本转义，防 XSS。
 * 规格：docs/tech/2026-06-22-md-table-edit-tech-design.md
 */

const inlineParser = baseParser.configure([Strikethrough]);

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** 标记节点（`**`、反引号、`~~`、链接括号）——渲染时吞掉、只留内容。 */
function isMark(name: string): boolean {
  return name.endsWith('Mark');
}

/** 安全 href：相对引用 / 锚点放行；带 scheme 的只放 http(s) / mailto，其余（javascript: 等）拒。 */
function isSafeHref(url: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
  return !scheme || /^(https?|mailto)$/i.test(scheme[1]);
}

function renderNode(text: string, node: SyntaxNode): string {
  switch (node.name) {
    case 'Document':
    case 'Paragraph':
      return renderChildren(text, node, node.from, node.to);
    case 'StrongEmphasis':
      return `<strong>${renderChildren(text, node, node.from, node.to)}</strong>`;
    case 'Emphasis':
      return `<em>${renderChildren(text, node, node.from, node.to)}</em>`;
    case 'Strikethrough':
      return `<del>${renderChildren(text, node, node.from, node.to)}</del>`;
    case 'InlineCode':
      // 反引号是 CodeMark、被 isMark 吞掉；码内无嵌套元素，renderChildren 只吐转义的字面文本
      return `<code>${renderChildren(text, node, node.from, node.to)}</code>`;
    case 'Link':
      return renderLink(text, node);
    case 'Escape':
      // \X → 字面 X（如 \| → |）
      return escapeHtml(text.slice(node.from + 1, node.to));
    default:
      // HTMLTag / 未知节点 → 字面转义文本
      return escapeHtml(text.slice(node.from, node.to));
  }
}

/** 渲染 node 落在 [lo,hi] 内的子节点：标记吞掉、其余递归，节点间的字面文本转义。 */
function renderChildren(text: string, node: SyntaxNode, lo: number, hi: number): string {
  let out = '';
  let pos = lo;
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.to <= lo || child.from >= hi) continue;
    if (child.from > pos) out += escapeHtml(text.slice(pos, child.from));
    if (!isMark(child.name)) out += renderNode(text, child);
    pos = child.to;
  }
  if (pos < hi) out += escapeHtml(text.slice(pos, hi));
  return out;
}

/** `[文字](url)`：文字区（`[`…`]` 之间）递归渲染、url 取 URL 节点；不安全/缺 url → 降级纯文本。 */
function renderLink(text: string, node: SyntaxNode): string {
  const marks = node.getChildren('LinkMark');
  const open = marks[0];
  const close = marks[1];
  if (!open || !close) return escapeHtml(text.slice(node.from, node.to));
  const inner = renderChildren(text, node, open.to, close.from);
  const url = node.getChild('URL');
  const href = url ? text.slice(url.from, url.to) : '';
  if (!url || !isSafeHref(href)) return inner;
  // target=_blank + noopener：Electron 渲染进程里点击经 setWindowOpenHandler 外开，绝不把编辑器整页导航走
  return `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
}

export function renderInline(md: string): string {
  const tree = inlineParser.parse(md);
  return renderNode(md, tree.topNode);
}
