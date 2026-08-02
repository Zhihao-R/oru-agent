/**
 * undoStack 单测——重点验证 key 已泛化为不透明字符串（artifactId 或绝对文件路径皆可）。
 *
 * Task 2 把 push/undo/redo/... 的形参语义从"仅 deck artifactId"泛化为"通用 key"
 * （HTML 预览编辑会用绝对路径当 key 复用同一撤销栈）。本模块只把 key 当 Map 键用、不解析其格式，
 * 故"用绝对路径当 key"必须与"用 artifactId 当 key"行为逐位一致——下面正是钉这一点。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  push,
  undo,
  redo,
  peekUndo,
  peekRedo,
  pushBarrier,
  clearAll,
  __snapshot,
  __resetAllForTest,
  type UndoEntry,
} from '../../electron/main/deck/undoStack';

afterEach(() => {
  __resetAllForTest();
});

// 造一个最小合法 inline-edit entry（before/after 都带 html）
function inlineEdit(before: string, after: string): UndoEntry {
  return {
    kind: 'inline-edit',
    before: { html: before },
    after: { html: after },
    meta: { pageIndex: 0 },
  };
}

describe('undoStack key 泛化', () => {
  const ABS_PATH = '/Users/foo/projects/p1/decks/d1/index.html';

  it('用绝对路径当 key：push → undo → redo 全程通', () => {
    const e = inlineEdit('<p>旧</p>', '<p>新</p>');
    push(ABS_PATH, e);

    expect(peekUndo(ABS_PATH)).toEqual(e);
    expect(peekRedo(ABS_PATH)).toBeNull();

    const undone = undo(ABS_PATH);
    expect(undone).toEqual(e);
    expect(peekUndo(ABS_PATH)).toBeNull(); // undo 栈空
    expect(peekRedo(ABS_PATH)).toEqual(e); // 进了 redo 栈

    const redone = redo(ABS_PATH);
    expect(redone).toEqual(e);
    expect(peekUndo(ABS_PATH)).toEqual(e); // 回到 undo 栈
    expect(peekRedo(ABS_PATH)).toBeNull();
  });

  it('绝对路径 key 与 artifactId key 行为逐位一致（同序列同快照）', () => {
    const e1 = inlineEdit('a', 'A');
    const e2 = inlineEdit('B', 'b');

    // 一路用 artifactId 当 key
    const artifactId = 'deck_abc123';
    push(artifactId, e1);
    push(artifactId, e2);
    undo(artifactId);

    // 同样序列、改用绝对路径当 key
    push(ABS_PATH, e1);
    push(ABS_PATH, e2);
    undo(ABS_PATH);

    expect(__snapshot(ABS_PATH)).toEqual(__snapshot(artifactId));
  });

  it('不同 key（两个绝对路径）各自独立一栈，互不串', () => {
    const pathA = '/x/a/index.html';
    const pathB = '/x/b/index.html';
    push(pathA, inlineEdit('a0', 'a1'));

    expect(peekUndo(pathA)).not.toBeNull();
    expect(peekUndo(pathB)).toBeNull(); // B 栈空，不受 A 影响

    undo(pathB); // 对空栈 undo 安全返回 null，不动 A
    expect(peekUndo(pathA)).not.toBeNull();
  });

  it('barrier 对绝对路径 key 同样挡住 undo', () => {
    push(ABS_PATH, inlineEdit('a', 'A'));
    pushBarrier(ABS_PATH); // 落版本插 barrier
    expect(undo(ABS_PATH)).toBeNull(); // 遇 barrier 返回 null
    // barrier 本身不被消费——undo 栈仍是 [inlineEdit, barrier] 两条（防"遇 barrier 误弹出"回归）
    expect(__snapshot(ABS_PATH).undo).toHaveLength(2);
    expect(peekUndo(ABS_PATH)).toBeNull();
  });

  it('clearAll 清空绝对路径 key 的栈', () => {
    push(ABS_PATH, inlineEdit('a', 'A'));
    clearAll(ABS_PATH);
    expect(__snapshot(ABS_PATH)).toEqual({ undo: [], redo: [] });
  });
});
