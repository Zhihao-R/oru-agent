import { EditorView } from '@codemirror/view';
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';

/**
 * 档案编辑器专属主题——只给 ProfileDocView 编辑态用，与其只读态 ProfileMarkdown 排版对齐，
 * 达成 demo 的「点编辑不骤变」：正文都是 sans 15px 灰（--text-secondary），标题都是衬线。
 *
 * 刻意与工作区文档编辑器的 baseTheme / mdHighlight（sans 15px 深色、无卡片内衬）分家——
 * 那套供 EditorPane 共用、字号色阶为工作区场景校准，不能被档案改动波及。
 * MdEditor 经 themeExtension / highlightStyle props 接入本主题，其余调用方不传、维持共享默认。
 */

const SERIF = '"New York", "Source Serif Pro", Georgia, serif';
const SANS = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", system-ui, sans-serif';

export const profileEditorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: 'transparent',
      // 正文与只读态 ProfileMarkdown 的 p 对齐：sans 15px 灰
      color: 'var(--text-secondary)',
      fontSize: '15px',
      fontFamily: SANS,
      height: 'auto',
    },
    '.cm-scroller': {
      fontFamily: 'inherit',
      lineHeight: '1.9',
      // 卡片内衬由 ProfileDocView 的 padding 承担，编辑器自身不再叠内边距
      padding: '0',
    },
    '.cm-content': {
      caretColor: 'var(--accent)',
      // 读态正文左对齐卡片内容，编辑器不再收窄/居中
      padding: '0',
      maxWidth: 'none',
      margin: '0',
    },
    '.cm-line': {
      padding: '1px 0',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'var(--accent-soft) !important',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: 'var(--accent)',
      borderLeftWidth: '2px',
    },
  },
  { dark: false },
);

export const profileHighlight = HighlightStyle.define([
  // 标题与 ProfileMarkdown h1/h2 对齐：衬线 23 / 18
  { tag: t.heading1, color: 'var(--text-primary)', fontWeight: '600', fontFamily: SERIF, fontSize: '23px' },
  { tag: t.heading2, color: 'var(--text-primary)', fontWeight: '600', fontFamily: SERIF, fontSize: '18px' },
  { tag: t.heading3, color: 'var(--text-primary)', fontWeight: '600', fontFamily: SERIF, fontSize: '16px' },
  { tag: [t.heading4, t.heading5, t.heading6], color: 'var(--text-primary)', fontWeight: '600', fontFamily: SERIF },
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
  // list / meta（bullet 标记）走弱灰，正文默认走 theme 的 secondary
  { tag: t.list, color: 'var(--text-secondary)' },
  { tag: t.meta, color: 'var(--text-quaternary)' },
  { tag: t.processingInstruction, color: 'var(--text-quaternary)' },
]);
