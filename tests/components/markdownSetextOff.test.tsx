/**
 * 回归：关掉 setext 下划线标题（2026-06-27）
 *
 * 正文紧跟一行 `-` / `=` 不再把上一段升格成标题——用户换行想打列表 `-`，整段却变粗变大的误触。
 * 编辑态（lezer）与渲染态（react-markdown / micromark）两套解析器同源关掉，这里两套都验；
 * `#` 井号标题与 `- ` 列表不受影响。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { EditorState } from '@codemirror/state';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { lezerDialect } from '@/lib/markdownDialect';

afterEach(cleanup);

describe('渲染态（micromark）关掉 setext', () => {
  it('正文紧跟一行 - 不升级为标题', () => {
    const { container } = render(<ChatMarkdown source={'来鼓2.0的问题在于：\n-'} />);
    expect(container.querySelector('h1, h2')).toBeNull();
  });

  it('正文紧跟一行 === 不升级为一级标题', () => {
    const { container } = render(<ChatMarkdown source={'标题\n==='} />);
    expect(container.querySelector('h1')).toBeNull();
  });

  it('# 井号标题不受影响', () => {
    const { container } = render(<ChatMarkdown source={'# 真标题'} />);
    expect(container.querySelector('h1')?.textContent).toBe('真标题');
  });

  it('- 加空格仍是列表', () => {
    const { container } = render(<ChatMarkdown source={'正文\n\n- 列表项'} />);
    expect(container.querySelector('ul li')?.textContent).toBe('列表项');
  });
});

describe('编辑态（lezer）关掉 setext', () => {
  function nodeNames(doc: string): string[] {
    const state = EditorState.create({
      doc,
      extensions: [markdown({ base: markdownLanguage, extensions: lezerDialect })],
    });
    const tree = ensureSyntaxTree(state, doc.length, 1e9)!;
    const names: string[] = [];
    tree.iterate({ enter: (n) => void names.push(n.name) });
    return names;
  }

  it('正文紧跟一行 - 不产生 SetextHeading 节点', () => {
    const names = nodeNames('来鼓2.0的问题在于：\n-');
    expect(names.some((n) => n.startsWith('SetextHeading'))).toBe(false);
  });

  it('# 井号标题仍解析为 ATXHeading', () => {
    const names = nodeNames('# 真标题');
    expect(names).toContain('ATXHeading1');
  });
});
