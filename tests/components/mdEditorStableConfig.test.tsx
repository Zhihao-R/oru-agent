// @vitest-environment jsdom

/**
 * MdEditor 配置稳定性回归（修「每击键全版面闪烁」）：
 *
 * EditorPane 订阅 editorStore 的 content，每次击键必重渲染，且 onChange/onSave/onAddToChat
 * 都是内联箭头函数——每渲染新引用。@uiw/react-codemirror 的 reconfigure effect 依赖里
 * 恰好有 extensions/onChange/onUpdate/basicSetup：任一引用变化就对 view 派发整编辑器
 * StateEffect.reconfigure，全新扩展实例让语言解析树、livePreview 装饰、高亮全部推倒重建
 * ——用户看到的就是所有文字渲染失效再重来的闪烁。
 *
 * 锁定的行为：value 未变、仅回调换新引用的重渲染（= 击键的 React 回流），编辑器不产生
 * 任何事务；同时回调经 ref 转发后必须仍是「活的」——重渲染后 ⌘S 调到最新 onSave 而非
 * 首渲染的旧闭包。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { EditorView } from '@codemirror/view';
import { MdEditor } from '@/components/editor/MdEditor';
import {
  getEditorView,
  __clearEditorViewsForTest,
} from '@/components/editor/editorViewRegistry';

const DOC_PATH = 'note.md';

/** 模拟 EditorPane 的真实用法：回调全部内联，每次渲染都是新引用。 */
function paneLike(
  value: string,
  cb: { onSave?: () => void; onChange?: (v: string) => void } = {},
): JSX.Element {
  return (
    <MdEditor
      value={value}
      onChange={cb.onChange ?? (() => {})}
      onSave={cb.onSave ?? (() => {})}
      onAddToChat={() => {}}
      docIdentity={{ projectId: 'p1', docPath: DOC_PATH }}
    />
  );
}

/** 等 @uiw 异步建好 view（onCreateEditor 在 effect 里跑）后从注册表取。 */
async function settledView(): Promise<EditorView> {
  await act(async () => {});
  const view = getEditorView(DOC_PATH);
  expect(view).toBeTruthy();
  return view!;
}

afterEach(() => {
  cleanup();
  __clearEditorViewsForTest();
});

describe('MdEditor 击键回流不重配编辑器', () => {
  it('value 未变、回调换新引用的重渲染 → 零事务（不触发 reconfigure）', async () => {
    const r = render(paneLike('hello *world*'));
    const view = await settledView();

    // 拦 dispatch 记账：击键回流本不该碰 view——任何事务（尤其 reconfigure）都是泄漏
    const dispatched: unknown[] = [];
    const orig = view.dispatch.bind(view);
    view.dispatch = ((...specs: never[]) => {
      dispatched.push(specs);
      return orig(...specs);
    }) as EditorView['dispatch'];

    r.rerender(paneLike('hello *world*'));
    await act(async () => {});

    expect(dispatched).toEqual([]);
  });

  it('重渲染换 onSave 后 ⌘S 调到最新回调，不冻在旧闭包', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const r = render(paneLike('hi', { onSave: first }));
    const view = await settledView();

    r.rerender(paneLike('hi', { onSave: second }));
    await act(async () => {});

    view.contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true, cancelable: true }),
    );
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
  });

  // onChange 是三条通路里后果最重的：EditorPane 的闭包捕获了 path，若转发器被误写成
  // 捕获 prop（冻在首渲染闭包），零事务用例仍绿，但改名后击键会静默写错文件。
  it('重渲染换 onChange 后编辑走到最新回调，不冻在旧闭包', async () => {
    const first = vi.fn();
    const second = vi.fn();
    const r = render(paneLike('hi', { onChange: first }));
    const view = await settledView();

    r.rerender(paneLike('hi', { onChange: second }));
    await act(async () => {});

    await act(async () => {
      view.dispatch({ changes: { from: 2, insert: '!' } });
    });
    expect(second).toHaveBeenCalledWith('hi!');
    expect(first).not.toHaveBeenCalled();
  });
});
