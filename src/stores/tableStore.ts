/**
 * tableStore —— 表格视图的数据模型 / 视图态（实时自动落盘，草稿机制下线）。
 *
 * 多标签（右栏标签工作区）下**按 path 分桶**：每个打开的表各存一份数据/视图态（排序/筛选/选区/撤销栈），
 * 切走不卸载、互不串改；模块级 debounce 也按 path 各一份（`timers`）。
 *
 * 三层语义：
 *   - 数据模型 {headers, rows} 全字符串，rows 永远保持文件序；排序/筛选是纯视图态。
 *   - 编辑只改内存 + 记操作日志（Op + 逆数据）；Op 撤销栈保留作 ⌘Z（会话内、重启清零）。
 *     编辑后停手约 0.8s 自动落盘（磁盘=屏幕、AI 读最新）；失焦/切文件/退出立即落。
 *   - 不丢由 main 侧统一临界区（overwrite-guard）保证；渲染端不再做磁盘哈希前置冲突。
 *     baseDiskSha 退化成「上次与磁盘同步过的字节哈希」，只用于 syncFromDisk 判外部是否改过。
 *
 * 正交保留：超限（>100,000 行）只读预览；不规范 CSV（GBK/BOM/风格）首次落盘前仍要用户
 * 选「转规范 / 另存副本」。跨度更大的「找回旧版」走 FileHistory（历史窗口，CsvEditor 入口）。
 */
import { create } from 'zustand';
import type {
  FsTextHashEvent,
  FsTextWriteResultEvent,
  FileHistoryRestoredEvent,
  TableOpenedEvent,
  TableProvenance,
  TablePrefs,
} from '@shared/protocol';
import { parseCsv, serializeCsv } from '@shared/csv';
import { ROW_LIMIT } from '@shared/tableLimits';
import { wsClient } from '@/lib/ws';
import { parentDir, relocateUnder, isUnder } from '@/lib/paths';
import { registerTabCloser } from '@/stores/workspaceStore';
import type { SortState } from '@/lib/tableStats';
import { normalizeRange, type TableSelection } from '@/lib/tableSelection';

/** 选中坐标在新表维度内是否仍存在（行/列都未越界）；越界=所在行/列被删→返回 null（失焦）。 */
function selectionStillValid(sel: TableSelection, rowCount: number, colCount: number): TableSelection {
  if (!sel) return null;
  if (sel.kind === 'col') return sel.col < colCount ? sel : null;
  const { r2, c2 } = normalizeRange(sel); // 锚点/焦点语义：右下角要经归一化才拿得到
  return r2 < rowCount && c2 < colCount ? sel : null;
}

type Op =
  | { kind: 'cell'; row: number; col: number; prev: string; next: string }
  | { kind: 'header'; col: number; prev: string; next: string }
  | { kind: 'insertRow'; at: number }
  | { kind: 'deleteRow'; at: number; prev: string[]; prevHeight?: number } // prevHeight = 被删行的行高覆盖（撤销时恢复）
  | { kind: 'insertCol'; at: number }
  | { kind: 'deleteCol'; at: number; prevHeader: string; prevCells: string[]; prevWidth?: number } // prevWidth 同理
  // 整块原子写（粘贴 / Delete 清空 / 全部替换共用），整块一次撤销。
  // rows 是**文件行号数组**而非起始行号：排序筛选后视图上连续的几行，文件里可能是第 5、17、203 行。
  // 数组让「无排序无筛选」退化成恰好连续的特例，一个代码路径覆盖全部视图状态。
  // 列不参与重排，所以列方向是起点 + 宽度——不对称是模型的真实形状，不为对称而对称。
  | {
      kind: 'block';
      rows: number[]; // 目标文件行号，可离散；含扩表新增的行号（追加在表尾）
      col: number; // 起始列
      prev: string[][]; // 与 next 同形；扩出来的位置存 ''
      next: string[][];
      prevWidths: number[]; // 与 rows 一一对应：各行写入前的宽度，撤销时各自截回
      prevRowCount: number; // 写入前的数据行数，撤销时截回
      prevColCount: number; // 写入前的列数，撤销时截回
    };

/** 单个打开表格的全部数据/视图态（一个标签一份）。 */
export type TableFileState = {
  projectId: string;
  headers: string[];
  rows: string[][];
  loading: boolean;
  saving: boolean;
  overLimit: boolean;
  previewRows: string[][] | null;
  totalRows: number | null;
  provenance: TableProvenance[];
  /** 只看编码：保存 / 导出前「要不要弹转换确认」的唯一判据（风格不规范无损定型，不打扰用户） */
  encodingSafe: boolean;
  encoding: 'utf-8' | 'gbk';
  savedText: string;
  baseDiskSha: string | null;
  mtimeMs: number;
  dirty: boolean;
  undoStack: Op[];
  redoStack: Op[];
  sort: SortState | null;
  filters: Map<number, Set<string>>;
  selection: TableSelection;
  pendingCanonicalConfirm: boolean;
  /** 该文件的表格视图偏好（列宽/整表行高）；随 table.open 回执捎带，改动走 commit* 落盘。无偏好为 {}。 */
  prefs: TablePrefs;
};

type TableState = {
  tables: Record<string, TableFileState>; // 按 path（项目相对）分桶

  open: (projectId: string, path: string) => Promise<void>;
  close: (path: string) => void;
  editCell: (path: string, row: number, col: number, value: string) => void;
  editHeader: (path: string, col: number, value: string) => void;
  insertRow: (path: string, at: number) => void;
  deleteRow: (path: string, at: number) => void;
  insertCol: (path: string, at: number) => void;
  deleteCol: (path: string, at: number) => void;
  /**
   * 整块原子写（粘贴 / 全部替换）：rows 是目标文件行号，可离散、可含超出末尾的新行号（自动扩表）。
   * 返回 false = 被行数上限拒绝，**一格都没动**（不静默截断）；文案由调用方出——store 与 i18n 解耦。
   */
  writeBlock: (path: string, rows: number[], col: number, block: string[][]) => boolean;
  /** 清空一块（Delete）：列一定连续，故是起点 + 宽度。内部构造全空串的 block。 */
  clearBlock: (path: string, rows: number[], col: number, width: number) => void;
  undo: (path: string) => void;
  redo: (path: string) => void;
  cycleSort: (path: string, col: number) => void;
  setFilter: (path: string, col: number, values: Set<string> | null) => void;
  setSelection: (path: string, sel: TableSelection) => void;
  setTotalRows: (path: string, n: number) => void;
  commitColumnWidths: (path: string, widths: number[]) => void; // 拖拽结束 → debounce 落盘
  commitRowHeight: (path: string, px: number, opts?: { immediate?: boolean }) => void; // 整表默认（下拉/拖拽）：拖拽→debounce、档位点击→immediate
  commitRowHeightAt: (path: string, row: number, px: number) => void; // 单行覆盖（拖某行底边）→ debounce 落盘
  flush: (path: string) => Promise<void>; // 立即落盘某表 pending（失焦/切文件/退出）
  flushAll: () => Promise<void>; // 落盘所有打开表（AI 动手前）
  manualSnapshot: (path: string) => Promise<void>; // ⌘S：立即落盘 + manual 留底
  resolveCanonical: (path: string, choice: 'convert' | 'saveCopy') => Promise<void>; // 不规范三选一
  requestCanonicalConfirm: (path: string) => void; // 显式弹规范确认（导出等「要动磁盘版但表未 dirty」场景）
  dismissCanonicalConfirm: (path: string) => void;
  syncFromDisk: (path: string) => Promise<void>; // 切回/外部变更：本地无改动则刷新成磁盘版
  restoreFromHistory: (path: string, snapshotId: string) => Promise<void>; // 找回旧版
  relocate: (oldRel: string, newRel: string) => void; // 改名/移动 → 分桶 key 跟随
  closeIfUnder: (path: string) => void; // 被删 → 关闭对应表桶
};

function serializeModel(headers: string[], rows: string[][]): string {
  return serializeCsv({ headers, rows });
}

// ── 自动落盘 debounce：计时器按 path 各一份 ──
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const AUTOSAVE_DEBOUNCE_MS = 800;

function cancelTimer(path: string): void {
  const t = timers.get(path);
  if (t) {
    clearTimeout(t);
    timers.delete(path);
  }
}

function scheduleAutosave(path: string): void {
  cancelTimer(path);
  timers.set(
    path,
    setTimeout(() => void useTableStore.getState().flush(path), AUTOSAVE_DEBOUNCE_MS),
  );
}

// ── 视图偏好 debounce：独立 Map，绝不与 csv 内容的 `timers` 共用（共用会互相 cancel）。 ──
const prefsTimers = new Map<string, ReturnType<typeof setTimeout>>();

function cancelPrefsTimer(path: string): void {
  const t = prefsTimers.get(path);
  if (t) {
    clearTimeout(t);
    prefsTimers.delete(path);
  }
}

// ── 操作日志：do / undo 都经这两个函数，结构变更对视图态的清理收在一处 ──
type Model = { headers: string[]; rows: string[][] };

function applyOp(model: Model, op: Op): Model {
  const { headers, rows } = model;
  switch (op.kind) {
    case 'cell': {
      const next = rows.slice();
      const row = next[op.row]!.slice();
      row[op.col] = op.next;
      next[op.row] = row;
      return { headers, rows: next };
    }
    case 'header': {
      const next = headers.slice();
      next[op.col] = op.next;
      return { headers: next, rows };
    }
    case 'insertRow': {
      const next = rows.slice();
      next.splice(op.at, 0, Array.from({ length: headers.length }, () => ''));
      return { headers, rows: next };
    }
    case 'deleteRow': {
      const next = rows.slice();
      next.splice(op.at, 1);
      return { headers, rows: next };
    }
    case 'insertCol': {
      const h = headers.slice();
      h.splice(op.at, 0, '');
      return { headers: h, rows: rows.map((r) => [...r.slice(0, op.at), '', ...r.slice(op.at)]) };
    }
    case 'deleteCol': {
      const h = headers.slice();
      h.splice(op.at, 1);
      return { headers: h, rows: rows.map((r) => [...r.slice(0, op.at), ...r.slice(op.at + 1)]) };
    }
    case 'block': {
      const colCount = Math.max(headers.length, op.col + (op.next[0]?.length ?? 0));
      // reduce 而非 Math.max(...arr)：展开十万级数组会 RangeError（栈溢出）
      const rowCount = op.rows.reduce((m, r) => Math.max(m, r + 1), rows.length);
      const next = rows.slice();
      while (next.length < rowCount) next.push([]);
      // **只动被写的行**：模型本来就允许行宽参差（中部空行就是短行），把未被写的行补齐到满列
      // 等于顺手改了它们，撤销时也无从知道各自原本多宽——落盘会凭空多出逗号。
      op.rows.forEach((fileRow, i) => {
        const line = op.next[i];
        if (!line) return;
        const target = (next[fileRow] ?? []).slice();
        while (target.length < op.col) target.push(''); // 落点在行尾之外时补出空隙
        line.forEach((v, j) => (target[op.col + j] = v));
        next[fileRow] = target;
      });
      const grown =
        colCount > headers.length
          ? [...headers, ...Array.from({ length: colCount - headers.length }, () => '')]
          : headers;
      return { headers: grown, rows: next };
    }
  }
}

function invertOp(model: Model, op: Op): Model {
  const { headers, rows } = model;
  switch (op.kind) {
    case 'cell':
      return applyOp(model, { ...op, next: op.prev });
    case 'header':
      return applyOp(model, { ...op, next: op.prev });
    case 'insertRow':
      return applyOp(model, { kind: 'deleteRow', at: op.at, prev: [] });
    case 'deleteRow': {
      const next = rows.slice();
      next.splice(op.at, 0, op.prev.slice());
      return { headers, rows: next };
    }
    case 'insertCol':
      return applyOp(model, { kind: 'deleteCol', at: op.at, prevHeader: '', prevCells: [] });
    case 'deleteCol': {
      const h = headers.slice();
      h.splice(op.at, 0, op.prevHeader);
      return {
        headers: h,
        rows: rows.map((r, i) => [...r.slice(0, op.at), op.prevCells[i] ?? '', ...r.slice(op.at)]),
      };
    }
    case 'block': {
      // 先按 prev 写回原值（与 apply 同一条路径），再把扩出来的行列截掉
      const restored = applyOp(model, { ...op, next: op.prev });
      const kept = restored.rows.slice(0, Math.min(restored.rows.length, op.prevRowCount));
      // 各行截回**自己**写入前的宽度：行宽在本模型里是逐行独立的（中部空行天生比表头短），
      // 一律按 prevColCount 收会把短行撑长、把长行削短。
      op.rows.forEach((fileRow, i) => {
        const width = op.prevWidths[i];
        const row = kept[fileRow];
        if (width === undefined || !row || row.length <= width) return;
        kept[fileRow] = row.slice(0, width);
      });
      const headers =
        restored.headers.length > op.prevColCount ? restored.headers.slice(0, op.prevColCount) : restored.headers;
      return { headers, rows: kept };
    }
  }
}

// block 两者皆假是**刻意**的：扩出来的行列只追加在末尾，已有行列的索引不变，
// 排序/筛选（按列索引）与选区（按行列坐标）都不会失效，没有清掉它们的理由。
// （注意这只是「不清空选区」，落点还留在原处；Excel 粘完会把选区扩到粘贴块，我们没有。）
const isStructuralCol = (op: Op): boolean => op.kind === 'insertCol' || op.kind === 'deleteCol';
const isStructural = (op: Op): boolean => isStructuralCol(op) || op.kind === 'insertRow' || op.kind === 'deleteRow';

// ── 结构增删时把「按行/列索引记住的偏好」跟着数据移位 ──
// 行高是稀疏 map（键=行号），插行让 >=at 的键 +1、删行丢掉 at 键并把 >at 的键 -1；
// 列宽是稠密数组（下标=列号），插列在 at 处塞占位（undefined→回落默认）、删列 splice 掉。
// 非结构 op（cell/header）返回原引用不变——调用方靠引用变化判断「要不要同步落盘」。

function shiftRowHeights(
  map: Record<number, number> | undefined,
  drop: number | null, // 要删掉的键（删行时=at，插行时=null）
  from: number, // 从此键起整体移位
  delta: number, // 移位量（插行 +1、删行 -1）
): Record<number, number> | undefined {
  if (!map) return map;
  const next: Record<number, number> = {};
  for (const [k, v] of Object.entries(map)) {
    const row = Number(k);
    if (row === drop) continue;
    next[row >= from ? row + delta : row] = v;
  }
  return next;
}

/** 前向（do / redo）：把偏好按结构 op 移位。 */
function applyPrefs(prefs: TablePrefs, op: Op): TablePrefs {
  switch (op.kind) {
    case 'insertRow':
      if (!prefs.rowHeightsPx) return prefs; // 无行高覆盖 → 无可移位，别凭空造 { rowHeightsPx: undefined }
      return { ...prefs, rowHeightsPx: shiftRowHeights(prefs.rowHeightsPx, null, op.at, +1) };
    case 'deleteRow':
      if (!prefs.rowHeightsPx) return prefs;
      return { ...prefs, rowHeightsPx: shiftRowHeights(prefs.rowHeightsPx, op.at, op.at, -1) };
    case 'insertCol': {
      if (!prefs.columnWidths) return prefs;
      const widths = prefs.columnWidths.slice();
      widths.splice(op.at, 0, undefined as unknown as number); // 新列无覆盖 → 占位 undefined，widthOf 回落默认
      return { ...prefs, columnWidths: widths };
    }
    case 'deleteCol': {
      if (!prefs.columnWidths) return prefs;
      const widths = prefs.columnWidths.slice();
      widths.splice(op.at, 1);
      return { ...prefs, columnWidths: widths };
    }
    case 'block':
      // 刻意 no-op：扩出来的行/列只追加在末尾，已有行列的索引不变，无可移位。
      // 显式写出来而非落进 default——applyPrefs/invertPrefs 的 switch 带 default，
      // 漏写分支不会编译红，只会静默什么都不做。
      return prefs;
    default:
      return prefs; // cell / header：不动偏好
  }
}

/** 丢弃 >= limit 的行高覆盖（block 撤销截回维度后清孤儿键）；无孤儿则保持原引用。 */
function dropRowHeightsFrom(
  map: Record<number, number> | undefined,
  limit: number,
): Record<number, number> | undefined {
  if (!map) return map;
  const kept = Object.entries(map).filter(([k]) => Number(k) < limit);
  return kept.length === Object.keys(map).length ? map : Object.fromEntries(kept);
}

/** 反向（undo）：结构 op 的逆——插的删掉、删的插回并恢复被删行/列的原覆盖。 */
function invertPrefs(prefs: TablePrefs, op: Op): TablePrefs {
  switch (op.kind) {
    case 'insertRow': // 逆 = 删掉 at 处（插入时新行无覆盖，其后 -1 复位）
      if (!prefs.rowHeightsPx) return prefs;
      return { ...prefs, rowHeightsPx: shiftRowHeights(prefs.rowHeightsPx, op.at, op.at, -1) };
    case 'deleteRow': {
      // 逆 = 在 at 处插回；被删行有覆盖则一并恢复
      if (!prefs.rowHeightsPx && op.prevHeight === undefined) return prefs;
      const shifted = shiftRowHeights(prefs.rowHeightsPx, null, op.at, +1);
      if (op.prevHeight === undefined) return { ...prefs, rowHeightsPx: shifted };
      return { ...prefs, rowHeightsPx: { ...shifted, [op.at]: op.prevHeight } };
    }
    case 'block': {
      // 截回维度后，指向已不存在行/列的覆盖必须一并丢弃，否则成孤儿键——下次行列数
      // 长回同一下标时，一个全新的行会凭空继承几步之前的旧行高。
      const rowHeightsPx = dropRowHeightsFrom(prefs.rowHeightsPx, op.prevRowCount);
      const columnWidths =
        prefs.columnWidths && prefs.columnWidths.length > op.prevColCount
          ? prefs.columnWidths.slice(0, op.prevColCount)
          : prefs.columnWidths;
      if (rowHeightsPx === prefs.rowHeightsPx && columnWidths === prefs.columnWidths) return prefs;
      return { ...prefs, rowHeightsPx, columnWidths };
    }
    case 'insertCol': { // 逆 = 删掉 at 处占位
      if (!prefs.columnWidths) return prefs;
      const widths = prefs.columnWidths.slice();
      widths.splice(op.at, 1);
      return { ...prefs, columnWidths: widths };
    }
    case 'deleteCol': { // 逆 = 在 at 处插回被删列宽
      if (!prefs.columnWidths && op.prevWidth === undefined) return prefs;
      const widths = (prefs.columnWidths ?? []).slice();
      widths.splice(op.at, 0, op.prevWidth as unknown as number);
      return { ...prefs, columnWidths: widths };
    }
    default:
      return prefs;
  }
}

/** 新建一个表桶的初值（除 projectId 外的默认态）。 */
function emptyFileState(projectId: string): TableFileState {
  return {
    projectId,
    headers: [],
    rows: [],
    loading: true,
    saving: false,
    overLimit: false,
    previewRows: null,
    totalRows: null,
    provenance: [],
    encodingSafe: true,
    encoding: 'utf-8',
    savedText: '',
    baseDiskSha: null,
    mtimeMs: 0,
    dirty: false,
    undoStack: [],
    redoStack: [],
    sort: null,
    filters: new Map(),
    selection: null,
    pendingCanonicalConfirm: false,
    prefs: {},
  };
}

function setWatch(projectId: string, path: string, on: boolean): void {
  void wsClient
    .request({ type: 'fs.watch', projectId, path: parentDir(path), on, owner: `table:${path}` })
    .catch(() => {});
}

function setSampling(projectId: string, path: string, on: boolean): void {
  void wsClient.request({ type: 'fs.history.sample', projectId, path, on }).catch(() => {});
}

export const useTableStore = create<TableState>((set, get) => {
  /** 读某 path 的桶（不在则 null）。 */
  const tableOf = (path: string): TableFileState | undefined => get().tables[path];

  /** 应用 patch 到某 path 的桶（桶不在则忽略——已被关/迁移）。 */
  function patchTable(path: string, patch: Partial<TableFileState>): void {
    const tables = get().tables;
    const t = tables[path];
    if (!t) return;
    set({ tables: { ...tables, [path]: { ...t, ...patch } } });
  }

  function removeTable(path: string): void {
    const { [path]: _removed, ...rest } = get().tables;
    void _removed;
    set({ tables: rest });
  }

  /** 编辑动作的公共收尾：入操作日志、清 redo、置 dirty、调度自动落盘。 */
  function pushOp(path: string, op: Op): void {
    const t = tableOf(path);
    if (!t) return;
    const model = applyOp({ headers: t.headers, rows: t.rows }, op);
    const prefs = applyPrefs(t.prefs, op); // 结构 op 让行高/列宽跟数据走；非结构返回原引用
    patchTable(path, {
      ...model,
      ...(prefs !== t.prefs ? { prefs } : {}),
      undoStack: [...t.undoStack, op],
      redoStack: [],
      dirty: true,
      ...(isStructural(op) ? { selection: null } : {}),
      ...(isStructuralCol(op) ? { sort: null, filters: new Map() } : {}),
    });
    scheduleAutosave(path);
    if (prefs !== t.prefs) schedulePrefsSet(path); // 重排后的偏好也要落盘，否则重开复现错位
  }

  /** open / reload 共用的装载。identity 守卫：await 后桶被换/关则丢弃。 */
  async function load(projectId: string, path: string): Promise<void> {
    set({ tables: { ...get().tables, [path]: emptyFileState(projectId) } });
    const bucket = get().tables[path];
    let opened: TableOpenedEvent;
    try {
      opened = await wsClient.request<TableOpenedEvent>({ type: 'table.open', projectId, path });
    } catch {
      if (get().tables[path] === bucket) patchTable(path, { loading: false });
      return;
    }
    if (get().tables[path] !== bucket) return; // await 间桶被关/重开
    if (opened.overLimit) {
      patchTable(path, {
        loading: false,
        overLimit: true,
        previewRows: opened.previewRows,
        provenance: opened.provenance,
        headers: opened.previewRows?.[0] ?? [],
        rows: [],
        prefs: opened.prefs ?? {},
      });
      return;
    }
    const disk = opened.content ?? '';
    const model = parseCsv(disk);
    patchTable(path, {
      loading: false,
      encodingSafe: opened.encodingSafe,
      encoding: opened.encoding,
      baseDiskSha: opened.sha256,
      mtimeMs: opened.mtimeMs,
      provenance: opened.provenance,
      headers: model.headers,
      rows: model.rows,
      savedText: disk,
      dirty: false,
      prefs: opened.prefs ?? {},
    });
  }

  /** 落盘成功后的公共收尾。 */
  function afterSaved(path: string, content: string, sha: string | undefined): void {
    cancelTimer(path);
    patchTable(path, {
      savedText: content,
      baseDiskSha: sha ?? null,
      dirty: false,
      saving: false,
      encodingSafe: true, // 写出的是 serializeCsv 产物，必然是规范 UTF-8
      pendingCanonicalConfirm: false,
    });
  }

  /**
   * 实时落盘内核：把某表当前模型写回磁盘。pending 内容在 await 前就快照（不丢）。
   * **编码**不安全的文件未决前不写、弹三选一；forceCanonical=true（用户已选「转规范」）时直接按规范格式重写。
   * 判据只看编码不看风格：GBK/BOM 转 UTF-8 落盘后原字节回不来，值得用户拍板；多余引号 / CRLF /
   * 缺尾换行是无损重写，用户面对「要不要转规范」时没有可判之处——拦它只是让 Excel、飞书导出的
   * 表每次保存都弹一句答不上来的话。
   */
  async function persist(path: string, mark?: 'manual', forceCanonical = false): Promise<void> {
    const t = tableOf(path);
    if (!t || t.overLimit) return;
    // 早返回只问「有没有要落盘的改动」——encodingSafe 是「要不要弹确认」的正交判据，不夹带进来。
    // （此前夹带 `&& t.canonical`，使不规范但未编辑的表在 blur / AI 动手前 flushAll / 关标签这些
    //  「无内容可写」的 flush 时也掉进下面弹确认框——用户没动也反复弹。要主动弹确认走 requestCanonicalConfirm。）
    if (!t.dirty && mark === undefined && !forceCanonical) return;
    if (!t.encodingSafe && !forceCanonical) {
      patchTable(path, { pendingCanonicalConfirm: true }); // 有改动要写、但编码不安全：不裸写，弹确认
      return;
    }
    const projectId = t.projectId;
    const content = serializeModel(t.headers, t.rows);
    patchTable(path, { saving: true });
    const bucket = get().tables[path];
    let res: FsTextWriteResultEvent;
    try {
      res = await wsClient.request<FsTextWriteResultEvent>({
        type: 'fs.writeText',
        projectId,
        path,
        content,
        mark, // 不传 expectedDiskSha256 → 走实时 overwrite-guard 路径
      });
    } catch {
      if (get().tables[path] === bucket) patchTable(path, { saving: false });
      return;
    }
    if (get().tables[path] !== bucket) return; // await 间桶被关/重开
    if (res.status !== 'saved') {
      patchTable(path, { saving: false });
      return;
    }
    afterSaved(path, content, res.sha256);
  }

  /**
   * 把某表桶内当前完整 prefs 覆盖式落盘。请求带 path 自寻址、prefsTimers 按 path 各一份，
   * 不存在把 A 的偏好写给 B 的路径，故不设 identity 守卫（设计文档同此结论）。桶已被关则跳过。
   */
  function sendPrefs(path: string): void {
    // 本函数同步、无 await、不让出 event loop，故不涉及并发重检（也是它不需 identity 守卫的论据之一）。
    cancelPrefsTimer(path);
    const t = tableOf(path);
    if (!t) return;
    void wsClient
      .request({ type: 'table.prefs.set', projectId: t.projectId, path, prefs: t.prefs })
      .catch(() => {});
  }

  function schedulePrefsSet(path: string): void {
    cancelPrefsTimer(path);
    prefsTimers.set(path, setTimeout(() => sendPrefs(path), AUTOSAVE_DEBOUNCE_MS));
  }

  return {
    tables: {},

    async open(projectId, path) {
      const existing = tableOf(path);
      if (existing && existing.projectId === projectId && !existing.loading) return; // 重开即切过去，保留现场
      setWatch(projectId, path, true);
      await load(projectId, path);
      const t = tableOf(path);
      if (t && t.projectId === projectId && !t.overLimit) setSampling(projectId, path, true);
    },

    close(path) {
      void get().flush(path); // 关闭前 flush（pending 在 flush 内 await 前快照，不丢）
      // 未落盘偏好 flush 兜底：有 pending 计时器就立即发出（用户 resize 完 800ms 内关标签不丢）；
      // sendPrefs 内部 cancelPrefsTimer，与注册成对清理。无 pending 则无改动、不必发。
      if (prefsTimers.has(path)) sendPrefs(path);
      const t = tableOf(path);
      if (t) {
        setWatch(t.projectId, path, false);
        setSampling(t.projectId, path, false);
      }
      cancelTimer(path);
      cancelPrefsTimer(path); // 兜底：sendPrefs 已含 cancel，此处只清理无 pending、未发出的路径（与 csv 侧 cancelTimer 对称）
      removeTable(path);
    },

    editCell(path, row, col, value) {
      const prev = tableOf(path)?.rows[row]?.[col] ?? '';
      if (prev === value) return;
      pushOp(path, { kind: 'cell', row, col, prev, next: value });
    },

    editHeader(path, col, value) {
      const prev = tableOf(path)?.headers[col] ?? '';
      if (prev === value) return;
      pushOp(path, { kind: 'header', col, prev, next: value });
    },

    insertRow(path, at) {
      pushOp(path, { kind: 'insertRow', at });
    },

    deleteRow(path, at) {
      const t = tableOf(path);
      const prev = t?.rows[at];
      if (!t || !prev) return;
      pushOp(path, { kind: 'deleteRow', at, prev: prev.slice(), prevHeight: t.prefs.rowHeightsPx?.[at] });
    },

    insertCol(path, at) {
      pushOp(path, { kind: 'insertCol', at });
    },

    deleteCol(path, at) {
      const t = tableOf(path);
      if (!t || at < 0 || at >= t.headers.length) return;
      pushOp(path, {
        kind: 'deleteCol',
        at,
        prevHeader: t.headers[at]!,
        prevCells: t.rows.map((r) => r[at] ?? ''),
        prevWidth: t.prefs.columnWidths?.[at],
      });
    },
    writeBlock(path, rows, col, block) {
      const t = tableOf(path);
      if (!t || t.overLimit) return false;
      const width = block[0]?.length ?? 0;
      if (width === 0 || rows.length === 0) return true; // 没什么可写 = 无事发生，不是「被上限拒绝」
      // 上限判在构造 op 之前：超了一格都不动，也不去真的把模型撑到十万行再回滚。
      // reduce 而非展开：十万级数组进 Math.max(...) 会栈溢出。
      if (rows.reduce((m, r) => Math.max(m, r + 1), t.rows.length) > ROW_LIMIT) return false;
      pushOp(path, {
        kind: 'block',
        rows,
        col,
        prev: rows.map((fileRow) => Array.from({ length: width }, (_, j) => t.rows[fileRow]?.[col + j] ?? '')),
        next: block,
        prevWidths: rows.map((fileRow) => t.rows[fileRow]?.length ?? 0),
        prevRowCount: t.rows.length,
        prevColCount: t.headers.length,
      });
      return true;
    },
    clearBlock(path, rows, col, width) {
      const blank = rows.map(() => Array.from({ length: width }, () => ''));
      get().writeBlock(path, rows, col, blank);
    },

    undo(path) {
      const t = tableOf(path);
      const op = t?.undoStack[t.undoStack.length - 1];
      if (!t || !op) return;
      const model = invertOp({ headers: t.headers, rows: t.rows }, op);
      const prefs = invertPrefs(t.prefs, op); // 撤销结构 op：行高/列宽逆向复位、恢复被删行/列覆盖
      const dirty = serializeModel(model.headers, model.rows) !== t.savedText;
      patchTable(path, {
        ...model,
        ...(prefs !== t.prefs ? { prefs } : {}),
        undoStack: t.undoStack.slice(0, -1),
        redoStack: [...t.redoStack, op],
        dirty,
        ...(isStructural(op) ? { selection: null } : {}),
        ...(isStructuralCol(op) ? { sort: null, filters: new Map() } : {}),
      });
      scheduleAutosave(path);
      if (prefs !== t.prefs) schedulePrefsSet(path);
    },

    redo(path) {
      const t = tableOf(path);
      const op = t?.redoStack[t.redoStack.length - 1];
      if (!t || !op) return;
      const model = applyOp({ headers: t.headers, rows: t.rows }, op);
      const prefs = applyPrefs(t.prefs, op); // 重做结构 op：与 do 同向移位
      const dirty = serializeModel(model.headers, model.rows) !== t.savedText;
      patchTable(path, {
        ...model,
        ...(prefs !== t.prefs ? { prefs } : {}),
        undoStack: [...t.undoStack, op],
        redoStack: t.redoStack.slice(0, -1),
        dirty,
        ...(isStructural(op) ? { selection: null } : {}),
        ...(isStructuralCol(op) ? { sort: null, filters: new Map() } : {}),
      });
      scheduleAutosave(path);
      if (prefs !== t.prefs) schedulePrefsSet(path);
    },

    cycleSort(path, col) {
      const t = tableOf(path);
      if (!t) return;
      const selected = t.selection?.kind === 'col' && t.selection.col === col;
      if (!selected) {
        patchTable(path, { selection: { kind: 'col', col } });
        return;
      }
      const cur = t.sort?.col === col ? t.sort : null;
      if (!cur) patchTable(path, { sort: { col, asc: true } });
      else if (cur.asc) patchTable(path, { sort: { col, asc: false } });
      else patchTable(path, { sort: null });
    },

    setFilter(path, col, values) {
      const t = tableOf(path);
      if (!t) return;
      const filters = new Map(t.filters);
      if (values === null || values.size === 0) filters.delete(col);
      else filters.set(col, values);
      patchTable(path, { filters });
    },

    setSelection(path, sel) {
      patchTable(path, { selection: sel });
    },

    setTotalRows(path, n) {
      patchTable(path, { totalRows: n });
    },

    commitColumnWidths(path, widths) {
      const t = tableOf(path);
      if (!t) return;
      // 桶更新同步、立即反映 UI；随后 debounce 落盘（发桶内完整 prefs）
      patchTable(path, { prefs: { ...t.prefs, columnWidths: widths } });
      schedulePrefsSet(path);
    },

    commitRowHeight(path, px, opts) {
      const t = tableOf(path);
      if (!t) return;
      patchTable(path, { prefs: { ...t.prefs, rowHeightPx: px } });
      // 档位点击是离散动作 → 立即写；拖拽结束 → debounce
      if (opts?.immediate) {
        cancelPrefsTimer(path);
        sendPrefs(path);
      } else {
        schedulePrefsSet(path);
      }
    },

    commitRowHeightAt(path, row, px) {
      const t = tableOf(path);
      if (!t) return;
      // 稀疏 map 合并既有覆盖，只钉这一行；拖拽结束走 debounce（与 commitColumnWidths 同步）
      const rowHeightsPx = { ...t.prefs.rowHeightsPx, [row]: px };
      patchTable(path, { prefs: { ...t.prefs, rowHeightsPx } });
      schedulePrefsSet(path);
    },

    async flush(path) {
      cancelTimer(path);
      await persist(path);
    },

    async flushAll() {
      await Promise.all(Object.keys(get().tables).map((p) => get().flush(p)));
    },

    async manualSnapshot(path) {
      cancelTimer(path);
      await persist(path, 'manual');
    },

    async resolveCanonical(path, choice) {
      const t = tableOf(path);
      if (!t) return;
      const projectId = t.projectId;
      const content = serializeModel(t.headers, t.rows);
      patchTable(path, { saving: true, pendingCanonicalConfirm: false });

      if (choice === 'saveCopy') {
        // 另存规范副本：原件逐字节不动；副本撞名加序号；写成后切到副本继续编辑
        const stem = path.replace(/\.csv$/i, '');
        for (let i = 0; ; i++) {
          const candidate = i === 0 ? `${stem}-规范.csv` : `${stem}-规范-${i + 1}.csv`;
          const bucket = get().tables[path];
          let res: FsTextWriteResultEvent;
          try {
            res = await wsClient.request<FsTextWriteResultEvent>({
              type: 'fs.writeText',
              projectId,
              path: candidate,
              content,
              expectedDiskSha256: null, // 期望不存在——存在则试下一个序号
            });
          } catch {
            if (get().tables[path] === bucket) patchTable(path, { saving: false });
            return;
          }
          if (res.status === 'saved') {
            if (get().tables[path] !== bucket) return; // await 间桶被关
            // 把桶迁到副本 path 继续编辑（原 path 桶销毁）
            setWatch(projectId, path, false);
            setSampling(projectId, path, false);
            setWatch(projectId, candidate, true);
            setSampling(projectId, candidate, true);
            const moved = { ...get().tables[path]! };
            removeTable(path);
            set({ tables: { ...get().tables, [candidate]: moved } });
            afterSaved(candidate, content, res.sha256);
            return;
          }
        }
      }

      // 转规范：原地按规范格式重写（用户已明确选择，强制写；写成后 afterSaved 置 canonical=true）
      await persist(path, undefined, true);
    },

    requestCanonicalConfirm(path) {
      const t = tableOf(path);
      // 与 persist 同一条判据（只有不可逆的编码转换值得拍板）——它只服务导出那条路，两处不能一严一宽
      if (t && !t.encodingSafe) patchTable(path, { pendingCanonicalConfirm: true }); // 编码安全则无需确认，静默 no-op
    },

    dismissCanonicalConfirm(path) {
      patchTable(path, { pendingCanonicalConfirm: false });
    },

    async syncFromDisk(path) {
      const t = tableOf(path);
      if (!t) return;
      const projectId = t.projectId;
      // G95 表格撞笔（PM 2026-07-12 定「AI 覆盖赢、不做冲突卡」）：不再「本地 dirty → 本地优先不刷新」——
      // 磁盘变了（含 AI 写）就 load 成磁盘版，无论本地是否 dirty。表格是二维结构、逐格冲突卡是要新建的重 UI，
      // 而未落盘编辑只是最后几百毫秒的输入，撞上 AI 写的窗口极窄，为它建二维冲突界面不划算（tech §6）。
      // 磁盘没变时下面 `h.sha256 === baseDiskSha` 自然早返回、保住本地编辑（含 pendingCanonicalConfirm 态）。
      // 代价（PM 已接受）：正改某格、还没自动落盘的那几百毫秒里 AI 若写了这张表，用户这笔在途输入被丢。
      if (t.overLimit) {
        await load(projectId, path);
        return;
      }
      const bucket = get().tables[path];
      let h: FsTextHashEvent;
      try {
        h = await wsClient.request<FsTextHashEvent>({ type: 'fs.textHash', projectId, path });
      } catch {
        return;
      }
      if (get().tables[path] !== bucket) return;
      if (h.sha256 === null) return; // 文件被删：保留当前
      if (h.sha256 === bucket.baseDiskSha) return; // 磁盘没变（含我们自己刚落盘）
      const prevSel = bucket.selection;
      await load(projectId, path); // 外部/AI 改过 → 刷新成磁盘版
      // 选中格去留（PRD 场景一·表格）：重读后选中坐标仍在则保持、所在行/列被删则失焦（load 已清成 null）
      const nt = get().tables[path];
      if (nt && nt.projectId === projectId) {
        const kept = selectionStillValid(prevSel, nt.rows.length, nt.headers.length);
        if (kept) patchTable(path, { selection: kept });
      }
    },

    async restoreFromHistory(path, snapshotId) {
      const t = tableOf(path);
      if (!t) return;
      const projectId = t.projectId;
      // 先把未落盘的本地编辑落盘——否则它没进磁盘、也没被 main 侧 pre-restore 兜进历史，会静默丢（不丢承诺）
      await get().flush(path);
      cancelTimer(path);
      const bucket = get().tables[path];
      const res = await wsClient.request<FileHistoryRestoredEvent>({
        type: 'fileHistory.restore',
        projectId,
        path,
        snapshotId,
      });
      if (res.type !== 'fileHistory.restored') return;
      if (get().tables[path] !== bucket) return;
      const model = parseCsv(res.content);
      patchTable(path, {
        headers: model.headers,
        rows: model.rows,
        savedText: res.content,
        dirty: false,
        undoStack: [],
        redoStack: [],
      });
    },

    relocate(oldRel, newRel) {
      const tables = get().tables;
      const nextTables: Record<string, TableFileState> = {};
      let changed = false;
      for (const [path, t] of Object.entries(tables)) {
        const next = relocateUnder(path, oldRel, newRel);
        if (next === null || next === path) {
          nextTables[path] = t;
          continue;
        }
        changed = true;
        // 哨兵盯父目录：旧 path 退订、新 path 订阅（父目录可能因移动而变）
        setWatch(t.projectId, path, false);
        setWatch(t.projectId, next, true);
        // timer 闭包捕获旧 path（触发即 flush(旧path) no-op）——清掉旧 timer，桶 dirty 则按 next 重排
        if (timers.has(path)) {
          cancelTimer(path);
          if (t.dirty) scheduleAutosave(next);
        }
        // 偏好 debounce 同理：旧 path timer 触发即写旧 path（桶已迁走 no-op）——重排到 next，未落盘偏好不丢
        if (prefsTimers.has(path)) {
          cancelPrefsTimer(path);
          prefsTimers.set(next, setTimeout(() => sendPrefs(next), AUTOSAVE_DEBOUNCE_MS));
        }
        nextTables[next] = t;
      }
      if (changed) set({ tables: nextTables });
    },

    closeIfUnder(path) {
      for (const p of Object.keys(get().tables)) {
        if (isUnder(p, path)) get().close(p);
      }
    },
  };
});

/**
 * 一次性事件桥：fs.changed（某表父目录）→ 该表 syncFromDisk；table.rowCount → 该表 totalRows。
 * 多标签下按 path 分发——每个打开的表都能响应自己的外部变更（AI 改盘），不只活跃那一个。
 */
let bound = false;
export function bindTableEvents(): void {
  if (bound) return;
  bound = true;
  wsClient.subscribe((ev) => {
    const s = useTableStore.getState();
    if (ev.type === 'fs.changed') {
      for (const [path, t] of Object.entries(s.tables)) {
        if (ev.projectId !== t.projectId) continue;
        if (ev.path === undefined || ev.path === parentDir(path)) void s.syncFromDisk(path);
      }
    } else if (ev.type === 'table.rowCount') {
      const t = s.tables[ev.path];
      if (t && ev.projectId === t.projectId) s.setTotalRows(ev.path, ev.totalRows);
    }
  });
}

// 标签关闭 → 销毁该表的桶（flush 未落盘内容后销毁）。见 workspaceStore.registerTabCloser。
registerTabCloser('table', (ref) => useTableStore.getState().close(ref));
