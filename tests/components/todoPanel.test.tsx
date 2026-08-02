/**
 * 计划清单卡：五种状态各自的渲染 + 卡住项在收起态也看得见 + 缺原因的卡住项显示占位文案。
 *
 * 收起态那条是要害：卡住是最需要用户注意的状态，不能只在展开后才出现（点阵在清单 >16 项时
 * 还不渲染，光靠点阵会整个漏掉）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TODO_STATUS_META } from '@shared/todo';
import type { TodoItem } from '@shared/types';
import { TodoPanel } from '@/components/chat/TodoPanel';
import { useTodoStore } from '@/stores/todoStore';

const CONV = 'conv-panel';

function show(items: TodoItem[]) {
  useTodoStore.getState().setTodos(CONV, items);
  return render(<TodoPanel conversationId={CONV} />);
}

beforeEach(() => useTodoStore.setState({ byConv: {} }));
afterEach(cleanup);

describe('计划清单卡', () => {
  it('空清单不占位', () => {
    const { container } = show([]);
    expect(container.firstChild).toBeNull();
  });

  it('展开后五种状态各自渲染，符号读元数据表', () => {
    show([
      { content: '待办项', status: 'pending' },
      { content: '进行项', status: 'in_progress' },
      { content: '卡住项', status: 'stuck', note: '缺密码' },
      { content: '完成项', status: 'done' },
      { content: '砍掉项', status: 'removed', note: '需求取消' },
    ]);
    fireEvent.click(screen.getByRole('button'));

    for (const [content, status] of [
      ['待办项', 'pending'],
      ['进行项', 'in_progress'],
      ['卡住项', 'stuck'],
      ['完成项', 'done'],
      ['砍掉项', 'removed'],
    ] as const) {
      const li = screen.getByText(new RegExp(content)).closest('li');
      expect(li?.textContent, `${status} 应显示元数据表里的符号`).toContain(TODO_STATUS_META[status].mark);
    }
    expect(screen.getByText(/缺密码/)).toBeTruthy();
    expect(screen.getByText(/需求取消/)).toBeTruthy();
  });

  it('划掉的项只划正文，不划原因（line-through 由祖先绘制、子元素取消不掉）', () => {
    show([{ content: '做配图', status: 'removed', note: '需求取消了' }]);
    fireEvent.click(screen.getByRole('button'));
    const note = screen.getByText(/需求取消了/);
    expect(note.className).not.toContain('line-through');
    expect(note.closest('.line-through')).toBeNull(); // 也不能挂在划线祖先里
    expect(screen.getByText('做配图').className).toContain('line-through');
  });

  it('缺 note 的卡住项显示占位文案（「卡住却不说卡在哪」要被看见）', () => {
    show([{ content: '连数据库', status: 'stuck' }]);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/未说明原因/)).toBeTruthy();
  });

  it('系统补出的 removed 留痕没有原因，不显示占位', () => {
    show([{ content: '被抹掉的活', status: 'removed' }]);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.queryByText(/未说明原因/)).toBeNull();
  });

  it('收起态：进度分母剔掉「不做了」的项（一份「做完 + 不做了」的清单该显示满格）', () => {
    show([
      { content: '查资料', status: 'done' },
      { content: '写草稿', status: 'done' },
      { content: '做配图', status: 'removed', note: '需求取消了' },
    ]);
    expect(screen.getByRole('button').textContent).toContain('2/2');
  });

  it('收起态：进度是 done/未移除总数，且卡住项计数直接可见', () => {
    show([
      { content: '查资料', status: 'done' },
      { content: '写草稿', status: 'in_progress' },
      { content: '连数据库', status: 'stuck' },
    ]);
    const header = screen.getByRole('button');
    expect(header.textContent).toContain('1/3');
    expect(header.textContent).toContain('1 项卡住');
  });

  it('收起态：没有卡住项就不显示卡住计数', () => {
    show([{ content: '查资料', status: 'done' }]);
    expect(screen.getByRole('button').textContent).not.toContain('卡住');
  });
});
