/**
 * 表格键盘判定内核 —— 「选区 + 按键」→「动作」。
 *
 * 承重不变量：
 *   - 坐标全是显示序：筛选态下按方向键走的是屏幕上相邻的行，不是文件里相邻的行。
 *   - 编辑态整体放行：格内输入框自己管方向键与 ⌘C/⌘X/⌘V，不能被整表级块操作顶替。
 *   - 两道只读门槛（超限预览 / 格式转换确认框）下移动与复制放行、写类动作全挡。
 *   - ⌃U 而非只有 F2：macOS 上 F2 默认是亮度键，只配 F2 等于这个入口按不出来。
 */
import { describe, expect, it } from 'vitest';
import { resolveTableKey, type TableKeyContext } from '@/components/table/tableKeyboard';
import type { TableSelection } from '@/lib/tableSelection';

const key = (k: string, mods: Partial<Record<'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey', boolean>> = {}) => ({
  key: k,
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  ...mods,
});

const at = (r: number, c: number): TableSelection => ({ kind: 'range', r1: r, c1: c, r2: r, c2: c });

/** 3 行 × 5 列的视图，选区默认在中心格。**刻意不用方阵**：maxR === maxC 时，
 *  把行上界写成列上界（或反之）的实现照样能通过全部边界与折行用例。 */
const ctx = (over: Partial<TableKeyContext> = {}): TableKeyContext => ({
  selection: at(1, 1),
  rowCount: 3,
  colCount: 5,
  readonly: false,
  editing: false,
  ...over,
});

describe('方向键移动', () => {
  it('四向各移一格并塌缩成单格', () => {
    expect(resolveTableKey(key('ArrowUp'), ctx())).toEqual({ kind: 'select', sel: at(0, 1) });
    expect(resolveTableKey(key('ArrowDown'), ctx())).toEqual({ kind: 'select', sel: at(2, 1) });
    expect(resolveTableKey(key('ArrowLeft'), ctx())).toEqual({ kind: 'select', sel: at(1, 0) });
    expect(resolveTableKey(key('ArrowRight'), ctx())).toEqual({ kind: 'select', sel: at(1, 2) });
  });

  it('四条边界都不越界', () => {
    expect(resolveTableKey(key('ArrowUp'), ctx({ selection: at(0, 0) }))).toEqual({ kind: 'select', sel: at(0, 0) });
    expect(resolveTableKey(key('ArrowLeft'), ctx({ selection: at(0, 0) }))).toEqual({ kind: 'select', sel: at(0, 0) });
    expect(resolveTableKey(key('ArrowDown'), ctx({ selection: at(2, 4) }))).toEqual({ kind: 'select', sel: at(2, 4) });
    expect(resolveTableKey(key('ArrowRight'), ctx({ selection: at(2, 4) }))).toEqual({ kind: 'select', sel: at(2, 4) });
  });

  it('从焦点而非锚点出发——反向框选判死：归一化取右下角的实现会给出另一个格子', () => {
    // 从 (2,2) 拖到 (0,0)：焦点是左上的 (0,0)，归一化后的右下角是 (2,2)
    const dragged: TableSelection = { kind: 'range', r1: 2, c1: 2, r2: 0, c2: 0 };
    // 正确实现从焦点 (0,0) 往右 → (0,1)；「取右下角」的实现会给 (2,3)
    expect(resolveTableKey(key('ArrowRight'), ctx({ selection: dragged }))).toEqual({ kind: 'select', sel: at(0, 1) });
  });

  it('还没有选区时第一次按方向键落在左上角，不跳过它', () => {
    expect(resolveTableKey(key('ArrowDown'), ctx({ selection: null }))).toEqual({ kind: 'select', sel: at(0, 0) });
    expect(resolveTableKey(key('Tab'), ctx({ selection: null }))).toEqual({ kind: 'select', sel: at(0, 0) });
  });
});

describe('Shift+方向扩选', () => {
  it('锚点不动、只挪焦点', () => {
    expect(resolveTableKey(key('ArrowRight', { shiftKey: true }), ctx())).toEqual({
      kind: 'select',
      sel: { kind: 'range', r1: 1, c1: 1, r2: 1, c2: 2 },
    });
  });

  it('已是多格选区时扩选仍从原锚点出发——把锚点也归一化的实现会露馅', () => {
    // 锚点 (2,2)、焦点 (1,1)：归一化会把锚点算成 (1,1)
    const sel: TableSelection = { kind: 'range', r1: 2, c1: 2, r2: 1, c2: 1 };
    expect(resolveTableKey(key('ArrowLeft', { shiftKey: true }), ctx({ selection: sel }))).toEqual({
      kind: 'select',
      sel: { kind: 'range', r1: 2, c1: 2, r2: 1, c2: 0 },
    });
  });

  it('反向扩选（往左上）保留方向，不被提前规范化', () => {
    expect(resolveTableKey(key('ArrowUp', { shiftKey: true }), ctx())).toEqual({
      kind: 'select',
      sel: { kind: 'range', r1: 1, c1: 1, r2: 0, c2: 1 },
    });
  });

  it('连续扩选从已扩的焦点继续，不是每次都从锚点重来', () => {
    const once = resolveTableKey(key('ArrowRight', { shiftKey: true }), ctx());
    expect(once).toEqual({ kind: 'select', sel: { kind: 'range', r1: 1, c1: 1, r2: 1, c2: 2 } });
    const twice = resolveTableKey(
      key('ArrowRight', { shiftKey: true }),
      ctx({ selection: (once as { sel: TableSelection }).sel }),
    );
    expect(twice).toEqual({ kind: 'select', sel: { kind: 'range', r1: 1, c1: 1, r2: 1, c2: 3 } });
  });
});

describe('Tab / Enter 走格', () => {
  it('Tab 右移，行尾折到下一行首', () => {
    expect(resolveTableKey(key('Tab'), ctx({ selection: at(1, 4) }))).toEqual({ kind: 'select', sel: at(2, 0) });
  });

  it('Shift+Tab 左移，行首折到上一行尾', () => {
    expect(resolveTableKey(key('Tab', { shiftKey: true }), ctx({ selection: at(1, 0) }))).toEqual({
      kind: 'select',
      sel: at(0, 4),
    });
  });

  it('表尾最后一格 Tab 不折出表，表首 Shift+Tab 同理', () => {
    expect(resolveTableKey(key('Tab'), ctx({ selection: at(2, 4) }))).toEqual({ kind: 'select', sel: at(2, 4) });
    expect(resolveTableKey(key('Tab', { shiftKey: true }), ctx({ selection: at(0, 0) }))).toEqual({
      kind: 'select',
      sel: at(0, 0),
    });
  });

  it('Enter 下移、Shift+Enter 上移，列不变', () => {
    expect(resolveTableKey(key('Enter'), ctx())).toEqual({ kind: 'select', sel: at(2, 1) });
    expect(resolveTableKey(key('Enter', { shiftKey: true }), ctx())).toEqual({ kind: 'select', sel: at(0, 1) });
  });
});

describe('进编辑', () => {
  it('可打印字符 → 以该字符覆盖原值', () => {
    expect(resolveTableKey(key('张'), ctx())).toEqual({ kind: 'edit', row: 1, col: 1, initial: '张' });
    expect(resolveTableKey(key('5'), ctx())).toEqual({ kind: 'edit', row: 1, col: 1, initial: '5' });
  });

  it('⌃U 保留原值进编辑（macOS 上 F2 是亮度键，主键位必须可达）', () => {
    expect(resolveTableKey(key('u', { ctrlKey: true }), ctx())).toEqual({ kind: 'edit', row: 1, col: 1, initial: null });
  });

  it('F2 作别名同样保留原值', () => {
    expect(resolveTableKey(key('F2'), ctx())).toEqual({ kind: 'edit', row: 1, col: 1, initial: null });
  });

  it('⌘U 不触发——只认 ⌃U，免得和系统/浏览器键位抢', () => {
    expect(resolveTableKey(key('u', { metaKey: true }), ctx())).toBeNull();
  });

  it('Option+字符不当作输入（macOS 上那是特殊字符组合）', () => {
    expect(resolveTableKey(key('π', { altKey: true }), ctx())).toBeNull();
  });
});

describe('清空与剪贴板', () => {
  it('Delete/Backspace 都给出清空动作（坐标由调用方在 await 后重读，不由内核带出）', () => {
    const sel: TableSelection = { kind: 'range', r1: 2, c1: 2, r2: 0, c2: 1 }; // 反向框选也一样
    expect(resolveTableKey(key('Delete'), ctx({ selection: sel }))).toEqual({ kind: 'clear' });
    expect(resolveTableKey(key('Backspace'), ctx({ selection: sel }))).toEqual({ kind: 'clear' });
  });

  it('整列选区不走块清空（列有自己的删除入口）', () => {
    expect(resolveTableKey(key('Delete'), ctx({ selection: { kind: 'col', col: 1 } }))).toBeNull();
  });

  it('⌘A 全选：锚点左上、焦点右下', () => {
    expect(resolveTableKey(key('a', { metaKey: true }), ctx())).toEqual({
      kind: 'select',
      sel: { kind: 'range', r1: 0, c1: 0, r2: 2, c2: 4 },
    });
  });

  it('整列选区不支持剪切/粘贴——否则 ⌘X 写进剪贴板却不清空源，静默变成复制', () => {
    const col = ctx({ selection: { kind: 'col', col: 1 } });
    expect(resolveTableKey(key('c', { metaKey: true }), col)).toEqual({ kind: 'copy' }); // 复制无副作用，放行
    expect(resolveTableKey(key('x', { metaKey: true }), col)).toBeNull();
    expect(resolveTableKey(key('v', { metaKey: true }), col)).toBeNull();
  });

  it('⌘C / ⌘X / ⌘V 各自成动作，无选区时不响应', () => {
    expect(resolveTableKey(key('c', { metaKey: true }), ctx())).toEqual({ kind: 'copy' });
    expect(resolveTableKey(key('x', { metaKey: true }), ctx())).toEqual({ kind: 'cut' });
    expect(resolveTableKey(key('v', { metaKey: true }), ctx())).toEqual({ kind: 'paste' });
    expect(resolveTableKey(key('c', { metaKey: true }), ctx({ selection: null }))).toBeNull();
  });

  it('⌘S / ⌘Z 不拦，留给 window 层', () => {
    expect(resolveTableKey(key('s', { metaKey: true }), ctx())).toBeNull();
    expect(resolveTableKey(key('z', { metaKey: true }), ctx())).toBeNull();
  });
});

describe('编辑态整体放行', () => {
  it('方向键、Enter、Delete 都交给输入框', () => {
    for (const k of ['ArrowDown', 'Enter', 'Delete', 'Tab', 'a']) {
      expect(resolveTableKey(key(k), ctx({ editing: true }))).toBeNull();
    }
  });

  it('⌘C / ⌘X / ⌘V 放行——格内复制不能被整表块操作顶替', () => {
    for (const k of ['c', 'x', 'v']) {
      expect(resolveTableKey(key(k, { metaKey: true }), ctx({ editing: true }))).toBeNull();
    }
  });
});

describe('只读门槛（超限预览 / 格式转换确认框）', () => {
  const ro = ctx({ readonly: true });

  it('移动、扩选、全选、复制照常放行——只读是不许写，不是不许看', () => {
    expect(resolveTableKey(key('ArrowDown'), ro)).toEqual({ kind: 'select', sel: at(2, 1) });
    expect(resolveTableKey(key('a', { metaKey: true }), ro)).toEqual({
      kind: 'select',
      sel: { kind: 'range', r1: 0, c1: 0, r2: 2, c2: 4 },
    });
    expect(resolveTableKey(key('c', { metaKey: true }), ro)).toEqual({ kind: 'copy' });
  });

  it('写类动作全挡：打字、⌃U、Delete、剪切、粘贴', () => {
    expect(resolveTableKey(key('张'), ro)).toBeNull();
    expect(resolveTableKey(key('u', { ctrlKey: true }), ro)).toBeNull();
    expect(resolveTableKey(key('F2'), ro)).toBeNull();
    expect(resolveTableKey(key('Delete'), ro)).toBeNull();
    expect(resolveTableKey(key('x', { metaKey: true }), ro)).toBeNull();
    expect(resolveTableKey(key('v', { metaKey: true }), ro)).toBeNull();
  });
});

describe('空表', () => {
  it('没有行或没有列时一律不响应', () => {
    expect(resolveTableKey(key('ArrowDown'), ctx({ rowCount: 0 }))).toBeNull();
    expect(resolveTableKey(key('a', { metaKey: true }), ctx({ colCount: 0 }))).toBeNull();
  });
});
