/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { history, undo } from '@codemirror/commands';
import { ensureSyntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { livePreview } from '@/components/editor/livePreview';

/**
 * TableWidget 运行时集成测试：真起 EditorView（jsdom），驱动 widget DOM 验证
 * 渲染 / 点格编辑 / 最小写回 / 增删行列 / 零失真——单元测试跳过的 toDOM 交互层。
 * jsdom 无布局，故列宽测量 / 拖拽不在此验（留真机），其余行为都可判定。
 */
let view: EditorView | null = null;
afterEach(() => {
  view?.destroy();
  view = null;
});

function mount(doc: string): EditorView {
  const state = EditorState.create({
    doc,
    extensions: [history(), markdown({ base: markdownLanguage }), livePreview()],
  });
  ensureSyntaxTree(state, doc.length, 1e9);
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  view = new EditorView({ state, parent });
  return view;
}

const fire = (el: Element, type: string): void => {
  el.dispatchEvent(new window.MouseEvent(type, { bubbles: true, cancelable: true }));
};
const key = (el: Element, k: string): void => {
  el.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
};

const TABLE = '前文\n\n| 能力 | **粗** |\n|---|---|\n| a | b |\n\n后文';

describe('TableWidget 渲染', () => {
  it('表格渲染成 <table>，格内 markdown 渲染、表外文本不受影响', () => {
    const v = mount(TABLE);
    const table = v.dom.querySelector('table');
    expect(table).not.toBeNull();
    // 表头第二格的 **粗** 渲染成 <strong>
    expect(table!.querySelector('thead strong')?.textContent).toBe('粗');
    // 数据行有 a / b
    const tds = [...v.dom.querySelectorAll('tbody td .cm-livemd-cell-content')].map((e) => e.textContent);
    expect(tds).toEqual(['a', 'b']);
  });

  it('半截表格（缺对齐行）不渲染成 table（保源码态）', () => {
    const v = mount('| 能力 | 工具 |\n| a | b |\n');
    expect(v.dom.querySelector('table')).toBeNull();
  });
});

describe('TableWidget 零失真', () => {
  it('载入不编辑 → 文档逐字节不变', () => {
    const v = mount(TABLE);
    expect(v.state.doc.toString()).toBe(TABLE);
  });
});

describe('TableWidget 点格编辑', () => {
  it('点格进入编辑，input 显示该格原始源码文本', () => {
    const v = mount(TABLE);
    const holder = v.dom.querySelector('thead th:nth-child(2) .cm-livemd-cell-content') as HTMLElement;
    fire(holder, 'mousedown');
    const input = v.dom.querySelector('.cm-livemd-cell-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('**粗**'); // 渲染态是 <strong>，编辑态露原文
  });

  it('改一个格 + 回车提交 → 只该格源码变、其余字节（含对齐行）不变', () => {
    const v = mount(TABLE);
    const holder = v.dom.querySelector('tbody td:first-child .cm-livemd-cell-content') as HTMLElement;
    fire(holder, 'mousedown');
    const input = v.dom.querySelector('.cm-livemd-cell-input') as HTMLInputElement;
    input.value = 'A!';
    key(input, 'Enter');
    expect(v.state.doc.toString()).toBe('前文\n\n| 能力 | **粗** |\n|---|---|\n| A! | b |\n\n后文');
  });

  it('Esc 取消编辑 → 文档不变、回到渲染态', () => {
    const v = mount(TABLE);
    const holder = v.dom.querySelector('tbody td:first-child .cm-livemd-cell-content') as HTMLElement;
    fire(holder, 'mousedown');
    const input = v.dom.querySelector('.cm-livemd-cell-input') as HTMLInputElement;
    input.value = '改了但要取消';
    key(input, 'Escape');
    expect(v.state.doc.toString()).toBe(TABLE);
  });

  it('格内输入竖线，提交时转义为 \\| 不破坏表格', () => {
    const v = mount(TABLE);
    const holder = v.dom.querySelector('tbody td:first-child .cm-livemd-cell-content') as HTMLElement;
    fire(holder, 'mousedown');
    const input = v.dom.querySelector('.cm-livemd-cell-input') as HTMLInputElement;
    input.value = 'x|y';
    key(input, 'Enter');
    expect(v.state.doc.toString()).toContain('| x\\|y | b |');
  });
});

describe('TableWidget 点击死角（走查二批该修 3）', () => {
  it('mousedown 直接派发到 td（非 holder 内容盒）→ 进入该格编辑', () => {
    // 修复前必红：handler 只绑在 holder 上，td 的 padding/边框空白是点击死角——事件冒泡到 CM
    // 被 ignoreEvent 吞掉，光标留在文档开头，打字污染标题。修复后绑定在整个 td 上。
    const v = mount(TABLE);
    const td = v.dom.querySelector('tbody td:first-child') as HTMLElement;
    fire(td, 'mousedown');
    const input = v.dom.querySelector('.cm-livemd-cell-input') as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe('a');
  });

  it('mousedown 派发到 resizeGrip / tools 按钮 → 不进编辑（列宽拖拽、增删行列不被截胡）', () => {
    const v = mount(TABLE);
    const grip = v.dom.querySelector('tbody td:first-child .cm-livemd-col-resize') as HTMLElement;
    fire(grip, 'mousedown');
    expect(v.dom.querySelector('.cm-livemd-cell-input')).toBeNull();

    const btn = v.dom.querySelector('.cm-livemd-row-tools button') as HTMLElement;
    fire(btn, 'mousedown'); // 触发的是增删行动作，不是格编辑
    expect(v.dom.querySelector('.cm-livemd-cell-input')).toBeNull();
  });

  it('连续点两格（前一格无改动）→ 前一格回渲染态、同时只有一个 input 且是后一格', () => {
    const v = mount(TABLE);
    const tdA = v.dom.querySelector('tbody td:first-child') as HTMLElement;
    const tdB = v.dom.querySelector('tbody td:nth-child(2)') as HTMLElement;
    fire(tdA, 'mousedown');
    fire(tdB, 'mousedown');
    const inputs = v.dom.querySelectorAll('.cm-livemd-cell-input');
    expect(inputs.length).toBe(1);
    expect((inputs[0] as HTMLInputElement).value).toBe('b');
    expect(v.state.doc.toString()).toBe(TABLE); // 无改动不提交
  });

  it('前一格有改动时点另一格 → 前一格改动提交落文档', () => {
    const v = mount(TABLE);
    const tdA = v.dom.querySelector('tbody td:first-child') as HTMLElement;
    const tdB = v.dom.querySelector('tbody td:nth-child(2)') as HTMLElement;
    fire(tdA, 'mousedown');
    const input = v.dom.querySelector('.cm-livemd-cell-input') as HTMLInputElement;
    input.value = 'A!';
    fire(tdB, 'mousedown');
    expect(v.state.doc.toString()).toContain('| A! | b |'); // 收尾=提交，不丢改动
  });
});

describe('TableWidget 增删行列', () => {
  it('点列头「右侧插入列」→ 表格多一列、对齐行同步', () => {
    const v = mount(TABLE);
    const btn = v.dom.querySelector('.cm-livemd-col-tools button[title="在右侧插入列"]') as HTMLElement;
    fire(btn, 'mousedown');
    expect(v.state.doc.toString()).toBe('前文\n\n| 能力 |  | **粗** |\n| --- | --- | --- |\n| a |  | b |\n\n后文');
  });

  it('点行首「下方插入行」→ 表格多一行空行', () => {
    const v = mount(TABLE);
    const btn = v.dom.querySelector('.cm-livemd-row-tools button[title="在下方插入行"]') as HTMLElement;
    fire(btn, 'mousedown');
    expect(v.state.doc.toString()).toBe('前文\n\n| 能力 | **粗** |\n| --- | --- |\n| a | b |\n|  |  |\n\n后文');
  });

  it('删列 + ⌘Z 撤销 → 回到原文（增删进编辑器撤销栈）', () => {
    const v = mount(TABLE);
    const del = v.dom.querySelector('.cm-livemd-col-tools button[title="删除本列"]') as HTMLElement;
    fire(del, 'mousedown');
    expect(v.state.doc.toString()).not.toBe(TABLE); // 删掉了一列
    undo(v); // 结构操作走普通 dispatch → 进 CM history → ⌘Z 可撤

    expect(v.state.doc.toString()).toBe(TABLE);
  });

  it('只剩一列时不出删除控件（保底留一列）', () => {
    const v = mount('| 只一列 |\n|---|\n| x |\n');
    expect(v.dom.querySelector('.cm-livemd-col-tools button[title="删除本列"]')).toBeNull();
  });

  it('只剩一行时不出删除控件（保底留一行）', () => {
    const v = mount('| a | b |\n|---|---|\n| x | y |\n');
    expect(v.dom.querySelector('.cm-livemd-row-tools button[title="删除本行"]')).toBeNull();
  });
});
