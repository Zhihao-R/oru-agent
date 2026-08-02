// @vitest-environment jsdom

/**
 * 「Oru 刚改过」段落高亮 CM 扩展（块②·场景一·文档，tech §3.2）：
 *  - addHighlight → 命中区间挂 mark decoration；clearHighlight → 移除。
 *  - 后续编辑移动高亮区间（mapPos）。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  recentChangeHighlight,
  addHighlight,
  clearHighlight,
} from '../../src/components/editor/recentChangeHighlight';

function mountView(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc, extensions: [recentChangeHighlight()] }), parent });
}

const marks = (view: EditorView) => view.dom.querySelectorAll('.oru-recent-change').length;

afterEach(() => {
  document.body.innerHTML = '';
});

describe('recentChangeHighlight', () => {
  it('addHighlight 挂高亮、clearHighlight 移除', () => {
    const view = mountView('hello world');
    expect(marks(view)).toBe(0);
    view.dispatch({ effects: addHighlight.of([{ from: 6, to: 11 }]) }); // 高亮 'world'
    expect(marks(view)).toBe(1);
    view.dispatch({ effects: clearHighlight.of(null) });
    expect(marks(view)).toBe(0);
  });

  it('空区间不挂（from===to）', () => {
    const view = mountView('abc');
    view.dispatch({ effects: addHighlight.of([{ from: 1, to: 1 }]) });
    expect(marks(view)).toBe(0);
  });

  it('高亮后区间外编辑 → 高亮随 mapPos 跟踪、不丢', () => {
    const view = mountView('hello world');
    view.dispatch({ effects: addHighlight.of([{ from: 6, to: 11 }]) });
    view.dispatch({ changes: { from: 0, to: 0, insert: 'X' } }); // 开头插入 → world 右移
    expect(marks(view)).toBe(1); // 仍在
  });
});
