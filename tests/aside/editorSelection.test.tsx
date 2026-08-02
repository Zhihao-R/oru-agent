/** @vitest-environment jsdom */
/**
 * MdEditor 注册的选区 getter：只有用户看得见的选区才算指认。
 * 回归场景：DeckCenter 文稿/预览标签常驻挂载、display:none 切换——切到预览后
 * NarrativeTab 的 MdEditor 仍活着，CodeMirror 失焦/隐藏都不清 selection.main；
 * 若残留选区参与解析，此后每次 ⌥点都会被那段不可见文本劫持。
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { EditorView } from '@uiw/react-codemirror';
import { MdEditor } from '@/components/editor/MdEditor';
import { getEditorSelectionText } from '@/components/editor/editorSelection';

beforeAll(() => {
  // jsdom 没有 checkVisibility / 布局引擎——按内联 display:none 沿祖先链补一个，
  // 足以回归"隐藏挂载"语义（生产环境走 Chromium 原生实现）
  if (!Element.prototype.checkVisibility) {
    Element.prototype.checkVisibility = function (this: Element): boolean {
      for (let el: Element | null = this; el; el = el.parentElement) {
        if ((el as HTMLElement).style?.display === 'none') return false;
      }
      return true;
    };
  }
});

afterEach(cleanup);

/** 挂载 MdEditor 并在 CodeMirror 内造一段选区，返回外层容器（用于切 display） */
function mountWithSelection(): HTMLElement {
  const { container } = render(
    <div data-testid="wrap">
      <MdEditor value="编辑器里选中的段落" onChange={() => {}} />
    </div>,
  );
  const cmDom = container.querySelector<HTMLElement>('.cm-editor');
  expect(cmDom).not.toBeNull();
  const view = EditorView.findFromDOM(cmDom!);
  expect(view).not.toBeNull();
  view!.dispatch({ selection: { anchor: 0, head: view!.state.doc.length } });
  return container.firstElementChild as HTMLElement;
}

describe('编辑器选区 getter 的可见性口径', () => {
  it('可见编辑器：选区参与解析', () => {
    mountWithSelection();
    expect(getEditorSelectionText()).toBe('编辑器里选中的段落');
  });

  it('隐藏编辑器（display:none 挂着）：残留选区不参与解析', () => {
    const wrap = mountWithSelection();
    wrap.style.display = 'none'; // 模拟 DeckCenter 切到预览标签
    expect(getEditorSelectionText()).toBe('');
  });
});
