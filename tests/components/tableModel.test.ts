import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  cellChangeAt,
  parseTable,
  serialize,
  withColDeleted,
  withColInserted,
  withRowDeleted,
  withRowInserted,
} from '@/components/editor/tableModel';

/**
 * tableModel 纯函数测试：建 EditorState（GFM）、强制整树解析、取 Table 节点。
 * 零失真硬约束的可判定化：cellChangeAt 只产出目标格区间的改动、区间外字节不变。
 */
function mkState(doc: string): EditorState {
  const state = EditorState.create({
    doc,
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 1e9);
  return state;
}

function tableNode(state: EditorState): SyntaxNode {
  let node: SyntaxNode | null = null;
  syntaxTree(state).iterate({
    enter: (r) => {
      if (r.name === 'Table') {
        node = r.node;
        return false;
      }
    },
  });
  if (!node) throw new Error('no Table node');
  return node;
}

function parse(doc: string) {
  const state = mkState(doc);
  return { state, model: parseTable(tableNode(state), state.doc) };
}

describe('parseTable', () => {
  it('解析表头 / 数据行的格文本', () => {
    const { model } = parse('| a | b |\n|---|---|\n| c | d |\n');
    expect(model.header.map((c) => c.text)).toEqual(['a', 'b']);
    expect(model.rows.map((r) => r.map((c) => c.text))).toEqual([['c', 'd']]);
  });

  it('对齐解析：:-: 居中、--: 右、--- 左、:-- 左', () => {
    const { model } = parse('| a | b | c | d |\n|:-:|--:|---|:--|\n| 1 | 2 | 3 | 4 |\n');
    expect(model.aligns).toEqual(['center', 'right', 'left', 'left']);
  });

  it('格内含粗体 / 代码的原始源码文本', () => {
    const { model } = parse('| **粗** | `c` |\n|---|---|\n| x | y |\n');
    expect(model.header.map((c) => c.text)).toEqual(['**粗**', '`c`']);
  });

  it('空单元格也按列对齐（按 delimiter gap 推导，不漏列）', () => {
    const { model } = parse('| a |  | c |\n|---|---|---|\n| x |  | z |\n');
    expect(model.header.map((c) => c.text)).toEqual(['a', '', 'c']);
    expect(model.rows[0].map((c) => c.text)).toEqual(['x', '', 'z']);
  });

  it('非空格子的 from/to 为去空白后的内容区间', () => {
    const doc = '| a | b |\n|---|---|\n| c | d |\n';
    const { state, model } = parse(doc);
    const cell = model.header[0];
    expect(state.doc.sliceString(cell.from, cell.to)).toBe('a');
  });
});

describe('serialize', () => {
  it('归一化表格 parse↔serialize 往返一致', () => {
    const src = '| a | b |\n| --- | :-: |\n| c | d |';
    const { model } = parse(src + '\n');
    expect(serialize(model)).toBe(src);
  });

  it('对齐落回正确记号（左 --- / 中 :-: / 右 ---:）', () => {
    const { model } = parse('| a | b | c |\n|---|:-:|--:|\n| 1 | 2 | 3 |\n');
    expect(serialize(model)).toBe('| a | b | c |\n| --- | :-: | ---: |\n| 1 | 2 | 3 |');
  });
});

describe('cellChangeAt：单格最小写回', () => {
  const doc = '| a | b |\n|---|---|\n| c | d |\n';

  it('改表头一格只产出该格区间的改动', () => {
    const { state } = parse(doc);
    const change = cellChangeAt(state, 0, { row: -1, col: 0 }, 'X', 'a');
    expect(change).toEqual({ from: doc.indexOf('a'), to: doc.indexOf('a') + 1, insert: 'X' });
  });

  it('改一格后整文档仅该格字节变、对齐行与其它格不变', () => {
    const { state } = parse(doc);
    const change = cellChangeAt(state, 0, { row: 0, col: 1 }, 'D!', 'd');
    expect(change).not.toBeNull();
    const next = state.update({ changes: change! }).state;
    expect(next.doc.toString()).toBe('| a | b |\n|---|---|\n| c | D! |\n');
  });

  it('原文核对失配（expectText 不符）→ null，不误改', () => {
    const { state } = parse(doc);
    expect(cellChangeAt(state, 0, { row: 0, col: 1 }, 'X', '旧值')).toBeNull();
  });

  it('提交内容与现状逐字节相同 → null（不产生空改动）', () => {
    const { state } = parse(doc);
    expect(cellChangeAt(state, 0, { row: -1, col: 0 }, 'a', 'a')).toBeNull();
  });

  it('格内未转义竖线提交时转义为 \\|，换行剥成空格', () => {
    const { state } = parse(doc);
    const change = cellChangeAt(state, 0, { row: -1, col: 0 }, 'x|y\nz', 'a');
    expect(change!.insert).toBe('x\\|y z');
  });

  it('已转义的 \\| 提交时不重复转义', () => {
    const d = '| x \\| y | b |\n|---|---|\n| c | d |\n';
    const { state } = parse(d);
    const change = cellChangeAt(state, 0, { row: -1, col: 0 }, 'x \\| y', 'x \\| y');
    expect(change).toBeNull(); // 逐字节相同 → no-op
  });

  it('偶数反斜杠后的裸竖线仍被转义（\\\\| → \\\\\\|）', () => {
    const { state } = parse(doc);
    // 用户输入字面「两个反斜杠 + 竖线」：前一个 \ 被后一个转义成字面 \，竖线是裸的须转义
    const change = cellChangeAt(state, 0, { row: -1, col: 0 }, 'a\\\\|b', 'a');
    expect(change!.insert).toBe('a\\\\\\|b');
  });

  it('空格子写回带单空格内边距、只动该格 gap', () => {
    const d = '| a |  | c |\n|---|---|---|\n| x | y | z |\n';
    const { state } = parse(d);
    const change = cellChangeAt(state, 0, { row: -1, col: 1 }, 'B', '');
    const next = state.update({ changes: change! }).state;
    expect(next.doc.toString()).toBe('| a | B | c |\n|---|---|---|\n| x | y | z |\n');
  });
});

describe('结构操作：增删行列', () => {
  const doc = '| a | b |\n| --- | --- |\n| c | d |';

  it('插入一列再删除回到原结构', () => {
    const { model } = parse(doc + '\n');
    const after = withColDeleted(withColInserted(model, 1), 1);
    expect(serialize(after)).toBe(serialize(model));
  });

  it('插入一行再删除回到原结构', () => {
    const { model } = parse(doc + '\n');
    const after = withRowDeleted(withRowInserted(model, 0), 0);
    expect(serialize(after)).toBe(serialize(model));
  });

  it('插入列：新列默认左对齐、内容为空', () => {
    const { model } = parse(doc + '\n');
    const after = withColInserted(model, 1);
    expect(after.aligns[1]).toBe('left');
    expect(after.header[1].text).toBe('');
    expect(serialize(after)).toBe('| a |  | b |\n| --- | --- | --- |\n| c |  | d |');
  });

  it('插入行：新行各格为空', () => {
    const { model } = parse(doc + '\n');
    const after = withRowInserted(model, 1);
    expect(serialize(after)).toBe('| a | b |\n| --- | --- |\n| c | d |\n|  |  |');
  });

  it('守卫：删到只剩一列 → no-op', () => {
    const { model } = parse('| a |\n| --- |\n| c |\n');
    expect(withColDeleted(model, 0)).toBe(model);
  });

  it('守卫：删到只剩一行 → no-op', () => {
    const { model } = parse('| a | b |\n| --- | --- |\n| c | d |\n');
    expect(withRowDeleted(model, 0)).toBe(model);
  });
});
