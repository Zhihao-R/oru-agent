/**
 * todo 选择器引用稳定性回归（S33 playtest 发现的 React #185 白屏）。
 *
 * 根因：TodoPanel 原来内联 `(s) => s.byConv[id] ?? []`——空清单时每次返回**新数组引用**，
 * zustand 按 Object.is 判变更 → useSyncExternalStore 每次快照都"变了" → setState 死循环
 * （Maximum update depth exceeded），任何挂了该组件的对话一渲染就白屏。
 * 修法：选择器收进 store、空清单回落模块级常量 EMPTY，引用跨调用稳定。
 */
import { describe, expect, it } from 'vitest';
import { selectTodoItems, useTodoStore } from '../../src/stores/todoStore';

describe('selectTodoItems 引用稳定（防 React #185 死循环）', () => {
  it('空清单：同一对话两次取值是同一个引用', () => {
    const state = useTodoStore.getState();
    const a = selectTodoItems('conv_none')(state);
    const b = selectTodoItems('conv_none')(state);
    expect(a).toEqual([]);
    expect(Object.is(a, b)).toBe(true);
  });

  it('不同对话的空清单也共享同一常量（不按 key 造新引用）', () => {
    const state = useTodoStore.getState();
    expect(Object.is(selectTodoItems('a')(state), selectTodoItems('b')(state))).toBe(true);
  });

  it('有清单：状态不变时引用不变，setTodos 后引用才变', () => {
    useTodoStore.getState().setTodos('conv_1', [{ content: 'x', status: 'pending' }]);
    const s1 = useTodoStore.getState();
    expect(Object.is(selectTodoItems('conv_1')(s1), selectTodoItems('conv_1')(s1))).toBe(true);
    useTodoStore.getState().setTodos('conv_1', [{ content: 'x', status: 'done' }]);
    const s2 = useTodoStore.getState();
    expect(Object.is(selectTodoItems('conv_1')(s1), selectTodoItems('conv_1')(s2))).toBe(false);
  });
});
