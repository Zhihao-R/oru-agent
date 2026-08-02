import { describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { DecorationSet } from '@codemirror/view';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { buildDecorations, linkUrlAt, tableDecorationField } from '@/components/editor/livePreview';

/**
 * 实时预览装饰计算的无头测试：只建 EditorState（不实例化 EditorView），
 * ensureSyntaxTree 强制整树解析后断言装饰区间。
 * 装饰分类口径（与 livePreview.ts 实现约定一致）：
 * - 隐藏：replace 且无 widget（spec.widget 为空、无 class）
 * - widget：spec.widget.kind ∈ bullet/task/hr
 * - 行级：from === to 且 spec.class
 * - 淡化：mark，spec.class === 'cm-livemd-fence'
 */

type Collected = {
  from: number;
  to: number;
  widgetKind?: string;
  cls?: string;
  checked?: boolean;
};

function mkState(doc: string, anchor = doc.length, head = anchor): EditorState {
  const state = EditorState.create({
    doc,
    selection: { anchor, head },
    // base 默认是 commonmark，删除线/任务/表格要 GFM——与 MdEditor 同口径
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, doc.length, 1e9);
  return state;
}

function collect(set: DecorationSet): Collected[] {
  const out: Collected[] = [];
  const it = set.iter();
  while (it.value) {
    const spec = it.value.spec as Record<string, unknown>; // Decoration.spec 是公开 API（类型为 any）
    const widget = spec.widget as { kind?: string; checked?: boolean } | undefined;
    out.push({
      from: it.from,
      to: it.to,
      widgetKind: widget?.kind,
      cls: spec.class as string | undefined,
      checked: widget?.checked,
    });
    it.next();
  }
  return out;
}

function decosOf(doc: string, anchor?: number, head?: number): Collected[] {
  const state = mkState(doc, anchor, head);
  return collect(buildDecorations(state, 0, doc.length));
}

function hidden(items: Collected[]): Collected[] {
  return items.filter((d) => d.to > d.from && !d.widgetKind && !d.cls);
}

function overlapping(items: Collected[], from: number, to: number): Collected[] {
  return items.filter((d) => d.from < to && d.to > from);
}

describe('buildDecorations：标记隐藏与光标行豁免', () => {
  it('标题标记（含后随空格）在非光标行被隐藏', () => {
    const doc = '# 标题\n\n正文';
    const items = hidden(decosOf(doc));
    expect(items).toContainEqual(expect.objectContaining({ from: 0, to: 2 }));
  });

  it('光标在标题行 → 该行无任何装饰', () => {
    const doc = '# 标题\n\n正文';
    const items = decosOf(doc, 1);
    expect(overlapping(items, 0, doc.indexOf('\n'))).toEqual([]);
  });

  it('多行选区覆盖的行全部豁免，未覆盖行照常隐藏', () => {
    const doc = '# A\n\n**b**\n';
    // 选区覆盖第 1-2 行（0..4），第 3 行的 **b** 不受影响
    const items = decosOf(doc, 0, 4);
    expect(overlapping(items, 0, 3)).toEqual([]);
    const strongStart = doc.indexOf('**b**');
    expect(hidden(items)).toContainEqual(
      expect.objectContaining({ from: strongStart, to: strongStart + 2 }),
    );
    expect(hidden(items)).toContainEqual(
      expect.objectContaining({ from: strongStart + 3, to: strongStart + 5 }),
    );
  });

  it('粗体/斜体/行内代码/删除线的标记被隐藏', () => {
    const doc = '**b** *i* `c` ~~s~~\n\nx';
    const items = hidden(decosOf(doc));
    for (const [mark, len] of [
      ['**b**', 2],
      ['*i*', 1],
      ['`c`', 1],
      ['~~s~~', 2],
    ] as const) {
      const start = doc.indexOf(mark);
      const end = start + mark.length;
      expect(items).toContainEqual(expect.objectContaining({ from: start, to: start + len }));
      expect(items).toContainEqual(expect.objectContaining({ from: end - len, to: end }));
    }
  });

  it('链接：方括号/圆括号/URL 隐藏，链接文字无装饰', () => {
    const doc = '[文字](http://u)\n\nx';
    const items = decosOf(doc);
    const urlStart = doc.indexOf('http://u');
    const urlEnd = urlStart + 'http://u'.length;
    // URL 每个字符都落在某个隐藏区间里
    for (let pos = urlStart; pos < urlEnd; pos++) {
      expect(hidden(items).some((d) => d.from <= pos && pos < d.to)).toBe(true);
    }
    const textStart = doc.indexOf('文字');
    expect(overlapping(items, textStart, textStart + 2)).toEqual([]);
  });
});

describe('buildDecorations：widget 替换', () => {
  it('无序列表符号替换为圆点 widget，有序数字原样保留', () => {
    const doc = '- a\n1. b\n\nx';
    const items = decosOf(doc);
    expect(items).toContainEqual(expect.objectContaining({ from: 0, to: 1, widgetKind: 'bullet' }));
    const ordStart = doc.indexOf('1.');
    expect(overlapping(items, ordStart, ordStart + 2)).toEqual([]);
  });

  it('任务列表：TaskMarker 替换为勾选框 widget、前导列表符隐藏', () => {
    const doc = '- [x] t\n- [ ] u\n\nx';
    const items = decosOf(doc);
    const m1 = doc.indexOf('[x]');
    const m2 = doc.indexOf('[ ]');
    expect(items).toContainEqual(
      expect.objectContaining({ from: m1, to: m1 + 3, widgetKind: 'task', checked: true }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ from: m2, to: m2 + 3, widgetKind: 'task', checked: false }),
    );
    // 任务行的 - 不出圆点，直接隐藏
    expect(items.filter((d) => d.widgetKind === 'bullet')).toEqual([]);
    expect(hidden(items)).toContainEqual(expect.objectContaining({ from: 0, to: 2 }));
  });

  it('分隔线替换为 hr widget', () => {
    const doc = 'x\n\n---\n\ny';
    const items = decosOf(doc);
    const start = doc.indexOf('---');
    expect(items).toContainEqual(
      expect.objectContaining({ from: start, to: start + 3, widgetKind: 'hr' }),
    );
  });
});

describe('buildDecorations：行级装饰', () => {
  it('引用：> 隐藏（含空格）+ 行 class；光标在行内时 > 露出但行 class 仍在', () => {
    const doc = '> q\n\nx';
    const items = decosOf(doc);
    expect(hidden(items)).toContainEqual(expect.objectContaining({ from: 0, to: 2 }));
    expect(items).toContainEqual(
      expect.objectContaining({ from: 0, to: 0, cls: 'cm-livemd-quote' }),
    );

    const onLine = decosOf(doc, 1);
    expect(hidden(onLine)).toEqual([]);
    expect(onLine).toContainEqual(
      expect.objectContaining({ from: 0, to: 0, cls: 'cm-livemd-quote' }),
    );
  });

  it('代码块：覆盖行有底色行 class，围栏行淡化不隐藏', () => {
    const doc = '```js\nlet a = 1\n```\n\nx';
    const items = decosOf(doc);
    const line2 = doc.indexOf('let');
    const line3 = doc.indexOf('```', 1 + doc.indexOf('\n'));
    for (const lineStart of [0, line2, line3]) {
      expect(items).toContainEqual(
        expect.objectContaining({ from: lineStart, to: lineStart, cls: 'cm-livemd-code' }),
      );
    }
    expect(items).toContainEqual(
      expect.objectContaining({ from: 0, to: 5, cls: 'cm-livemd-fence' }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ from: line3, to: line3 + 3, cls: 'cm-livemd-fence' }),
    );
    expect(hidden(items)).toEqual([]);
  });
});

describe('buildDecorations：退化与保真', () => {
  it('表格范围内零装饰（原样文本）', () => {
    const doc = '| a | b |\n|---|---|\n| c | d |\n\nx';
    const items = decosOf(doc);
    const tableEnd = doc.lastIndexOf('|') + 1;
    expect(overlapping(items, 0, tableEnd)).toEqual([]);
  });

  it('装饰层不碰文档：含 * 列表/连续空行/frontmatter 的原文逐字节不变', () => {
    const doc = '---\ntitle: x\n---\n\n* a\n\n\n\nb';
    const state = mkState(doc);
    buildDecorations(state, 0, doc.length);
    expect(state.doc.toString()).toBe(doc);
  });
});

describe('表格 block 装饰（StateField，非 ViewPlugin）', () => {
  function fieldState(doc: string, anchor = 0): EditorState {
    const state = EditorState.create({
      doc,
      selection: { anchor },
      extensions: [markdown({ base: markdownLanguage }), tableDecorationField],
    });
    ensureSyntaxTree(state, doc.length, 1e9);
    return state;
  }
  function tableDecos(state: EditorState): { from: number; to: number; block?: boolean; kind?: string }[] {
    const out: { from: number; to: number; block?: boolean; kind?: string }[] = [];
    const it = state.field(tableDecorationField).iter();
    while (it.value) {
      const spec = it.value.spec as Record<string, unknown>;
      const widget = spec.widget as { kind?: string } | undefined;
      out.push({ from: it.from, to: it.to, block: spec.block as boolean, kind: widget?.kind });
      it.next();
    }
    return out;
  }

  it('完整表格 → 一个 block 表格 widget，覆盖到表末行尾', () => {
    const doc = '前文\n\n| a | b |\n|---|---|\n| c | d |\n\n后文';
    const decos = tableDecos(fieldState(doc));
    expect(decos).toHaveLength(1);
    expect(decos[0]).toMatchObject({ block: true, kind: 'table' });
    const tableStart = doc.indexOf('| a');
    expect(decos[0].from).toBe(tableStart);
    // to 取表末行的行尾（不含行尾换行），覆盖整表
    expect(decos[0].to).toBe(doc.indexOf('| c | d |') + '| c | d |'.length);
  });

  it('半截表格（缺对齐行）→ 不产 block 装饰，保源码态', () => {
    const doc = '| a | b |\n| c | d |\n';
    expect(tableDecos(fieldState(doc))).toEqual([]);
  });

  it('仅 selectionSet 的事务不重建装饰（引用不变）', () => {
    const doc = '| a | b |\n|---|---|\n| c | d |\n';
    const s0 = fieldState(doc, 0);
    const set0 = s0.field(tableDecorationField);
    const s1 = s0.update({ selection: { anchor: 3 } }).state;
    expect(s1.field(tableDecorationField)).toBe(set0);
  });

  it('docChanged 的事务重建装饰', () => {
    const doc = '| a | b |\n|---|---|\n| c | d |\n';
    const s0 = fieldState(doc, 0);
    const set0 = s0.field(tableDecorationField);
    const s1 = s0.update({ changes: { from: 0, insert: 'x\n\n' } }).state;
    expect(s1.field(tableDecorationField)).not.toBe(set0);
  });
});

describe('linkUrlAt', () => {
  const doc = '前文 [文字](http://example.com) 后文';

  it('命中链接文字 → 返回 URL', () => {
    expect(linkUrlAt(mkState(doc), doc.indexOf('文字') + 1)).toBe('http://example.com');
  });

  it('命中 URL 部分 → 返回 URL', () => {
    expect(linkUrlAt(mkState(doc), doc.indexOf('example'))).toBe('http://example.com');
  });

  it('命中普通文本 → null', () => {
    expect(linkUrlAt(mkState(doc), 0)).toBeNull();
  });
});
