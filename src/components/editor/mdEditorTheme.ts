import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * Markdown 编辑器主题与语法高亮：完全用 CSS 变量驱动，跟整体配色无缝衔接。
 * 严禁紫色 / 渐变 / 大圆角。
 */

export const baseTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'var(--bg-canvas)',
      color: 'var(--text-primary)',
      height: '100%',
      // 正文 14px，与对话正文（.oru-chat-md）统一字号；行距 1.75 更疏朗
      fontSize: '14px',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif',
    },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: '1.75',
      padding: '40px 0 80px',
    },
    '.cm-content': {
      caretColor: 'var(--accent)',
      padding: '0 24px',
      maxWidth: '640px',
      margin: '0 auto',
    },
    '.cm-line': {
      padding: '0',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-gutters': {
      backgroundColor: 'transparent',
      color: 'var(--text-tertiary)',
      border: 'none',
    },
    // 实时预览后不再高亮当前行：进出编辑的唯一视觉变化是标记浮现/消失（PRD）
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--accent-soft) !important',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--accent)',
      borderLeftWidth: '2px',
    },
    '.cm-foldPlaceholder': {
      backgroundColor: 'var(--bg-sunken)',
      color: 'var(--text-secondary)',
      border: '1px solid var(--border-default)',
      borderRadius: '4px',
      padding: '0 4px',
    },
    '.cm-tooltip': {
      backgroundColor: 'var(--bg-elevated)',
      color: 'var(--text-primary)',
      border: '1px solid var(--border-default)',
      borderRadius: '6px',
    },
    '.cm-searchMatch': {
      backgroundColor: 'var(--accent-soft)',
      outline: '1px solid var(--accent)',
    },
  },
  { dark: false },
);

// 标题衬线（与对话正文 markdown 标题同一套衬线基调；比例同 .oru-chat-md：h1 1.5em / h2 1.25em，基础 14px）
const SERIF = '"New York", "Source Serif Pro", Georgia, serif';

export const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, color: 'var(--text-primary)', fontWeight: '600', fontFamily: SERIF, fontSize: '1.5em' },
  { tag: t.heading2, color: 'var(--text-primary)', fontWeight: '600', fontFamily: SERIF, fontSize: '1.25em' },
  { tag: t.heading3, color: 'var(--text-primary)', fontWeight: '600', fontSize: '1.08em' },
  { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--text-primary)', fontWeight: '600' },
  { tag: t.strong, color: 'var(--text-primary)', fontWeight: '600' },
  { tag: t.emphasis, color: 'var(--text-primary)', fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through', color: 'var(--text-tertiary)' },
  { tag: t.link, color: 'var(--accent)', textDecoration: 'underline' },
  { tag: t.url, color: 'var(--accent)' },
  {
    tag: t.monospace,
    color: 'var(--accent)',
    backgroundColor: 'var(--accent-soft)',
    fontFamily: "'SF Mono', ui-monospace, Menlo, Monaco, monospace",
  },
  { tag: t.quote, color: 'var(--text-secondary)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--text-primary)' },
  { tag: t.meta, color: 'var(--text-tertiary)' },
  { tag: t.comment, color: 'var(--text-tertiary)', fontStyle: 'italic' },
  { tag: t.processingInstruction, color: 'var(--text-tertiary)' },
  { tag: t.atom, color: 'var(--accent)' },
  { tag: t.keyword, color: 'var(--accent)' },
  { tag: t.string, color: 'var(--success)' },
  { tag: t.number, color: 'var(--accent)' },
]);
