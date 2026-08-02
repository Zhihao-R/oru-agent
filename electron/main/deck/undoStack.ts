/**
 * 内存 undo stack（每 key 独立一栈，上限 100）
 *
 * key 是不透明字符串——可以是 deck artifactId，也可以是绝对文件路径（HTML 预览编辑复用同一栈）。
 * 本模块只把 key 当 Map 键用，从不解析其格式，调用方用什么粒度自洽即可。
 *
 * - 跨会话不持久化（重启清零，PRD §4 决策）
 * - barrier 在落版本时插入：Ctrl+Z 遇到 barrier 返回 null
 * - checkout 时 clearAll：避免跨版本撤销到不存在状态
 *
 * 数据建模（v1）：所有可还原 entry 统一成 before/after 快照对，
 * applyUndo / applyRedo 只关心快照里哪些字段有值 → 写盘对应文件。
 * after 缺省时表示"不可 redo"（subagent 输出非确定性，重放不安全）。
 *
 * 详 tech doc §10
 */
import type { Annotation } from '@shared/types';

const MAX_STACK_SIZE = 100;

/** 一次状态快照——可以只含 html、只含 annotations、或两者都含 */
export type UndoStateSnapshot = {
  html?: string;
  annotations?: Annotation[];
};

export type UndoEntry =
  | { kind: 'barrier' }
  | {
      /**
       * kind 标识来源，applyUndo 不分支用它（按 snapshot 字段实际有什么决定要写什么）。
       * - 'inline-edit': 行内编辑（before/after 都有 html）
       * - 'annotation-change': annotation 增/删/改（before/after 都有 annotations）
       * - 'batch-applied': 批量提交完成（before 有 html + annotations；无 after 不可 redo）
       * - 'ai-direct': AI 直接改（聊天指令）（before 有 html；无 after 不可 redo）
       * - 'reorder': 拖拽重排页面（before/after 都有 html + annotations）
       */
      kind: 'inline-edit' | 'annotation-change' | 'batch-applied' | 'ai-direct' | 'reorder';
      before: UndoStateSnapshot;
      after?: UndoStateSnapshot;
      /** 元数据——给 UI 显示用（撤销了哪个 marker / 哪一页），applyUndo 本身不使用 */
      meta?: { markerId?: string; pageIndex?: number };
    };

type Stack = { undo: UndoEntry[]; redo: UndoEntry[] };

const stacks = new Map<string, Stack>();

function getOrInit(key: string): Stack {
  let s = stacks.get(key);
  if (!s) {
    s = { undo: [], redo: [] };
    stacks.set(key, s);
  }
  return s;
}

export function push(key: string, entry: UndoEntry): void {
  const s = getOrInit(key);
  s.undo.push(entry);
  // 新动作 → redo 失效
  s.redo = [];
  // 超 cap 丢最早；barrier 也算条目计入 cap
  while (s.undo.length > MAX_STACK_SIZE) s.undo.shift();
}

/** 看 undo 栈顶但不消费；遇到 barrier 返回 null（同 undo() 语义） */
export function peekUndo(key: string): UndoEntry | null {
  const s = stacks.get(key);
  if (!s || s.undo.length === 0) return null;
  const top = s.undo[s.undo.length - 1];
  if (top.kind === 'barrier') return null;
  return top;
}

/** 看 redo 栈顶但不消费 */
export function peekRedo(key: string): UndoEntry | null {
  const s = stacks.get(key);
  if (!s || s.redo.length === 0) return null;
  return s.redo[s.redo.length - 1];
}

/** 撤销一步；返回被撤销的 entry 或 null（栈空 / 遇到 barrier）。barrier **不**被消费 */
export function undo(key: string): UndoEntry | null {
  const s = stacks.get(key);
  if (!s || s.undo.length === 0) return null;
  const top = s.undo[s.undo.length - 1];
  if (top.kind === 'barrier') return null;
  s.undo.pop();
  s.redo.push(top);
  return top;
}

/** 重做一步；返回被重做的 entry 或 null（redo 栈空） */
export function redo(key: string): UndoEntry | null {
  const s = stacks.get(key);
  if (!s || s.redo.length === 0) return null;
  const top = s.redo.pop();
  if (!top) return null;
  s.undo.push(top);
  return top;
}

/** 在 undo 栈顶 push 一个 barrier；落版本（commitVersion）时调 */
export function pushBarrier(key: string): void {
  const s = getOrInit(key);
  if (s.undo.length > 0 && s.undo[s.undo.length - 1].kind === 'barrier') return;
  s.undo.push({ kind: 'barrier' });
  s.redo = [];
}

/** 清空某 key 的 undo + redo 栈；checkout 时由 history.checkoutVersion 调 */
export function clearAll(key: string): void {
  stacks.delete(key);
}

/** 仅测试用：返回栈快照 */
export function __snapshot(key: string): { undo: UndoEntry[]; redo: UndoEntry[] } {
  const s = stacks.get(key);
  return { undo: s ? [...s.undo] : [], redo: s ? [...s.redo] : [] };
}

export function __resetAllForTest(): void {
  stacks.clear();
}
