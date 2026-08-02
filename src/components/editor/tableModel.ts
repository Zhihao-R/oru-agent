import type { EditorState, Text } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

/**
 * lezer GFM `Table` 节点 ↔ 结构模型，纯函数（脱 CodeMirror 视图可单测）。
 * 文档永远是 markdown 源码：渲染只读模型、单格编辑走 cellChangeAt 最小原位写回、
 * 增删行列走结构操作 + serialize 整表重排。零失真天生成立——没编辑就不 dispatch。
 * 规格：docs/tech/2026-06-22-md-table-edit-tech-design.md
 */

export type Align = 'left' | 'center' | 'right';

/** 渲染时的内容区间 + 原始源码文本（from/to 仅供定位写回起点）。 */
export interface CellRef {
  from: number;
  to: number;
  text: string;
}

export interface TableModel {
  from: number;
  to: number;
  aligns: Align[];
  header: CellRef[];
  rows: CellRef[][];
}

/** 把对齐行的一段（如 `:-:` / `--:` / `---`）解析成对齐。右=尾冒号、中=首尾冒号，其余=左。 */
function segAlign(seg: string): Align {
  const s = seg.trim();
  const left = s.startsWith(':');
  const right = s.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  return 'left';
}

/** 解析整行对齐行 `|:-:|--:|---|` → 各列对齐（去掉首尾空段）。 */
function parseAligns(line: string): Align[] {
  return line
    .split('|')
    .slice(1, -1)
    .map(segAlign);
}

/** 取一格：gap 去空白后即内容区间；空格子保留整个 gap（写回时补单空格内边距）。 */
function makeCell(doc: Text, gapFrom: number, gapTo: number): CellRef {
  const raw = doc.sliceString(gapFrom, gapTo);
  const text = raw.trim();
  if (text === '') return { from: gapFrom, to: gapTo, text: '' };
  const lead = raw.length - raw.trimStart().length;
  const trail = raw.length - raw.trimEnd().length;
  return { from: gapFrom + lead, to: gapTo - trail, text };
}

/**
 * 从一行（TableHeader / TableRow）按 `|`（TableDelimiter）的间隙推导各格。
 * 不能用 getChildren('TableCell')——GFM 空单元格不产 TableCell 节点，会漏列致错位。
 */
function parseRowCells(rowNode: SyntaxNode, doc: Text): CellRef[] {
  const delims: number[][] = [];
  for (let c = rowNode.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableDelimiter') delims.push([c.from, c.to]);
  }
  const cells: CellRef[] = [];
  for (let i = 0; i + 1 < delims.length; i++) {
    cells.push(makeCell(doc, delims[i][1], delims[i + 1][0]));
  }
  return cells;
}

/**
 * 解析 `Table` 节点。对齐行是 Table 的直接子 TableDelimiter（行内 `|` 是各行的子节点，不混入）。
 * aligns 补齐 / 截到列数，让模型每列都有对齐。
 */
export function parseTable(node: SyntaxNode, doc: Text): TableModel {
  let aligns: Align[] = [];
  const rowNodes: SyntaxNode[] = [];
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.name === 'TableHeader' || c.name === 'TableRow') rowNodes.push(c);
    else if (c.name === 'TableDelimiter') aligns = parseAligns(doc.sliceString(c.from, c.to));
  }
  const allRows = rowNodes.map((rn) => parseRowCells(rn, doc));
  const header = allRows[0] ?? [];
  const cols = header.length;
  while (aligns.length < cols) aligns.push('left');
  return {
    from: node.from,
    to: node.to,
    aligns: aligns.slice(0, cols),
    header,
    rows: allRows.slice(1),
  };
}

function alignToken(a: Align): string {
  return a === 'center' ? ':-:' : a === 'right' ? '---:' : '---';
}

/** 模型 → 归一化整表源码（单空格内边距）。仅供结构操作整表重排，不用于单格最小写回。 */
export function serialize(m: TableModel): string {
  const line = (cells: string[]): string => `| ${cells.join(' | ')} |`;
  return [
    line(m.header.map((c) => c.text)),
    line(m.aligns.map(alignToken)),
    ...m.rows.map((r) => line(r.map((c) => c.text))),
  ].join('\n');
}

/** 找覆盖 pos 的 Table 节点（pos = widget 根的实时 table.from）。bias=1 向右解析：pos 恰在表起点边界时取表内节点而非前一节点。 */
function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  for (let n: SyntaxNode | null = syntaxTree(state).resolveInner(pos, 1); n; n = n.parent) {
    if (n.name === 'Table') return n;
  }
  return null;
}

/**
 * 按实时 pos 重解析当前表：返回模型 + 整表替换范围 [model.from, lineTo]（lineTo=表末行行尾，
 * 含行边界，block replace 要求在行边界）。结构操作用——提交时取实时坐标，await/外部改写后不错位。
 */
export function tableAt(
  state: EditorState,
  pos: number,
): { model: TableModel; lineTo: number } | null {
  const node = tableNodeAt(state, pos);
  if (!node) return null;
  return { model: parseTable(node, state.doc), lineTo: state.doc.lineAt(node.to).to };
}

/**
 * 提交前转义：未转义的 `|` → `\|`，换行剥成空格（一格一行，PRD 不做格内换行）。
 * lookbehind 感知偶数个反斜杠——`\|`（奇数 `\`，已转义）跳过，`\\|`（偶数 `\`，`|` 实为裸）仍转义，
 * 否则只看一个 `\` 会把 `\\|` 误判为已转义、漏掉破坏表格的裸竖线。
 */
function escapeCell(raw: string): string {
  return raw.replace(/\r?\n/g, ' ').replace(/(?<!\\)((?:\\\\)*)\|/g, '$1\\|');
}

/**
 * 单格最小写回：按提交时刻的实时 table.from 重解析当前 Table，按 (row,col) 索引取格
 * （block widget 内 posAtDOM 全坍缩到 widget 起点，无法用 pos 区分格，只能靠索引）。
 * 原文与 expectText 失配 → null（并发外部改写后不误改）；逐字节相同 → null（不产空改动）。
 * row < 0 表示表头。
 */
export function cellChangeAt(
  state: EditorState,
  tableFrom: number,
  ref: { row: number; col: number },
  raw: string,
  expectText: string,
): { from: number; to: number; insert: string } | null {
  const node = tableNodeAt(state, tableFrom);
  if (!node) return null;
  const m = parseTable(node, state.doc);
  const cell = ref.row < 0 ? m.header[ref.col] : m.rows[ref.row]?.[ref.col];
  if (!cell || cell.text !== expectText) return null;

  const escaped = escapeCell(raw);
  // 空格子 from/to 是整个 gap（含空格）→ 补单空格内边距，保持 `| x |` 排版
  const insert = cell.text === '' ? ` ${escaped} ` : escaped;
  if (state.doc.sliceString(cell.from, cell.to) === insert) return null;
  return { from: cell.from, to: cell.to, insert };
}

function emptyCell(): CellRef {
  return { from: 0, to: 0, text: '' };
}

function insertAt<T>(arr: readonly T[], at: number, item: T): T[] {
  const next = arr.slice();
  next.splice(at, 0, item);
  return next;
}

function removeAt<T>(arr: readonly T[], at: number): T[] {
  const next = arr.slice();
  next.splice(at, 1);
  return next;
}

/** 在第 at 列插入空列（默认左对齐）。 */
export function withColInserted(m: TableModel, at: number): TableModel {
  return {
    ...m,
    aligns: insertAt(m.aligns, at, 'left'),
    header: insertAt(m.header, at, emptyCell()),
    rows: m.rows.map((r) => insertAt(r, at, emptyCell())),
  };
}

/** 删第 at 列；只剩一列时 no-op（保底留一列）。 */
export function withColDeleted(m: TableModel, at: number): TableModel {
  if (m.header.length <= 1) return m;
  return {
    ...m,
    aligns: removeAt(m.aligns, at),
    header: removeAt(m.header, at),
    rows: m.rows.map((r) => removeAt(r, at)),
  };
}

/** 在第 at 行插入空数据行。 */
export function withRowInserted(m: TableModel, at: number): TableModel {
  return { ...m, rows: insertAt(m.rows, at, m.header.map(() => emptyCell())) };
}

/** 删第 at 行；只剩一行数据时 no-op（保底留一行）。 */
export function withRowDeleted(m: TableModel, at: number): TableModel {
  if (m.rows.length <= 1) return m;
  return { ...m, rows: removeAt(m.rows, at) };
}
