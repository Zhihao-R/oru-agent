/** @vitest-environment jsdom */
/**
 * DeleteConfirm 无 error 且无 children 时不得渲染空 body 容器。
 * 根因：曾恒传 [error?p:null, children] 两个子表达式，即使都为 null，
 * Dialog 收到的仍是非空数组、`children ?` 判真，渲出只剩内边距（px-5 py-4）的空容器，
 * 表现为弹窗标题与按钮行之间一块空白。修后：无内容传 undefined，有 error 才渲容器。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { DeleteConfirm } from '@/components/ui/DeleteConfirm';

// Dialog body 容器唯一标识：裸 div.px-5.py-4（header 同 padding 但是 <header> 标签、footer 是 py-3）
function bodyContainer() {
  return document.querySelector('div.px-5.py-4');
}

afterEach(cleanup);

describe('DeleteConfirm 空 body', () => {
  it('无 error 无 children：不渲染空 body 容器', () => {
    render(<DeleteConfirm open title="删除任务？" onConfirm={() => {}} onClose={() => {}} />);
    expect(bodyContainer()).toBeNull();
  });

  it('有 error：渲染 body 容器并含错误文案', () => {
    render(
      <DeleteConfirm open title="删除任务？" error="删除失败" onConfirm={() => {}} onClose={() => {}} />,
    );
    const el = bodyContainer();
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('删除失败');
  });

  it('有 children：渲染 body 容器', () => {
    render(
      <DeleteConfirm open title="删除任务？" onConfirm={() => {}} onClose={() => {}}>
        <span>附加说明</span>
      </DeleteConfirm>,
    );
    const el = bodyContainer();
    expect(el).not.toBeNull();
    expect(el?.textContent).toContain('附加说明');
  });
});
