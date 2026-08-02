// @vitest-environment jsdom

/**
 * 冲突对照卡 CM 扩展（块②·PRD 场景二，tech §4）：
 *  - resolvedText 三动作落定文本。
 *  - 冻结：冲突区间内改动被拒、区间外照常。
 *  - 解决：点「用 Oru 的」替换为 theirsText + 移除卡 + 回调 onResolve。
 *  - 定位：区间外插入后冲突 range 随 mapPos 跟踪，解决落点仍正确。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { EditorState } from '@codemirror/state';
import {
  conflictCards,
  addConflicts,
  resolvedText,
  activeConflictCount,
  type ConflictSpec,
} from '../../src/components/editor/conflictCard';

function mountView(doc: string): EditorView {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc, extensions: [conflictCards()] }), parent });
}

function spec(over: Partial<ConflictSpec> = {}): ConflictSpec {
  return {
    id: 'c1',
    from: 2,
    to: 6,
    mineText: 'MINE',
    theirsText: 'THEIRS',
    onResolve: () => {},
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('resolvedText', () => {
  it('三动作落定文本', () => {
    const s = { mineText: 'A', theirsText: 'B' };
    expect(resolvedText(s, 'mine')).toBe('A');
    expect(resolvedText(s, 'theirs')).toBe('B');
    expect(resolvedText(s, 'both')).toBe('AB'); // 两个都留=mine 顺次接 theirs
  });
});

describe('冻结 + 解决', () => {
  it('冲突区间内的改动被拒、区间外照常', () => {
    const view = mountView('ab MINE cd'); // 冲突区间 [3,7)=MINE（'ab '=0..3）
    view.dispatch({ effects: addConflicts.of([spec({ from: 3, to: 7 })]) });
    expect(activeConflictCount(view)).toBe(1);

    // 区间内改动（pos 4）→ 被冻结，doc 不变
    view.dispatch({ changes: { from: 4, to: 5, insert: 'X' } });
    expect(view.state.doc.toString()).toBe('ab MINE cd');

    // 区间外改动（开头）→ 照常
    view.dispatch({ changes: { from: 0, to: 0, insert: 'Z' } });
    expect(view.state.doc.toString()).toBe('Zab MINE cd');
  });

  it('点「用 Oru 的」→ 冲突区间替换为 theirsText + 卡移除 + 回调', () => {
    const onResolve = vi.fn();
    const view = mountView('ab MINE cd');
    view.dispatch({ effects: addConflicts.of([spec({ from: 3, to: 7, onResolve })]) });

    const btns = Array.from(view.dom.querySelectorAll<HTMLButtonElement>('.oru-conflict-btn'));
    const useTheirs = btns.find((b) => b.textContent === '用 Oru 的');
    expect(useTheirs).toBeTruthy();
    useTheirs!.click();

    expect(view.state.doc.toString()).toBe('ab THEIRS cd'); // 替换为 theirs
    expect(activeConflictCount(view)).toBe(0); // 卡已移除
    expect(onResolve).toHaveBeenCalledWith('theirs');
  });

  it('点「两个都留」→ mine 顺次接 theirs', () => {
    const view = mountView('ab MINE cd');
    view.dispatch({ effects: addConflicts.of([spec({ from: 3, to: 7 })]) });
    const both = Array.from(view.dom.querySelectorAll<HTMLButtonElement>('.oru-conflict-btn')).find(
      (b) => b.textContent === '两个都留',
    );
    both!.click();
    expect(view.state.doc.toString()).toBe('ab MINETHEIRS cd');
  });

  it('区间外插入后冲突 range 随 mapPos 跟踪，解决落点仍正确', () => {
    const onResolve = vi.fn();
    const view = mountView('ab MINE cd');
    view.dispatch({ effects: addConflicts.of([spec({ from: 3, to: 7, onResolve })]) });
    // 在开头插入 3 个字符 → 冲突区间右移到 [6,10)
    view.dispatch({ changes: { from: 0, to: 0, insert: 'XYZ' } });
    expect(view.state.doc.toString()).toBe('XYZab MINE cd');
    // 解决「用 Oru 的」应替换的是跟踪后的 MINE 段，不是旧坐标
    const useTheirs = Array.from(view.dom.querySelectorAll<HTMLButtonElement>('.oru-conflict-btn')).find(
      (b) => b.textContent === '用 Oru 的',
    );
    useTheirs!.click();
    expect(view.state.doc.toString()).toBe('XYZab THEIRS cd');
  });
});
