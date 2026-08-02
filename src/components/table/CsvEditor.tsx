/**
 * CsvEditor —— 表格视图（"看"为主：固定表头、斑马纹、列宽可拖；实时自动落盘 + ⌘Z 撤销）。
 *
 * 与 EditorPane 同构的外壳（标题栏 / 历史入口 / 关闭），表格特有的：
 *   - 视图态（排序三态 / 按值筛选 / 选区统计条）全在内存，怎么折腾都不写文件；
 *   - Op 撤销栈作 ⌘Z（会话内）；编辑停手自动落盘，失焦立即落；找回旧版走历史窗口；
 *   - 超限只读预览（前 1,000 行 + 总行数异步补报）；
 *   - 来源条（同目录脚本声明的产物反查，纯信息展示，不带任何按钮）；
 *   - 不规范文件首次落盘/导出前的「转规范 / 另存副本」确认（编码/格式决定，realtime 下照旧）。
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  ChevronDown,
  ChevronsUpDown,
  Download,
  Filter,
  History,
  Loader2,
  Redo2,
  Search,
  Rows3,
  Undo2,
} from 'lucide-react';
import type { TableExportedEvent, TablePrefs } from '@shared/protocol';
import { serializeCsv } from '@shared/csv';
import { cn } from '@/lib/cn';
import { wsClient } from '@/lib/ws';
import { displayIndexes } from '@/lib/tableStats';
import { computeStatsForSelection, isCellSelected, normalizeRange } from '@/lib/tableSelection';
import { toastError } from '@/lib/toast';
import { resolveTableKey } from './tableKeyboard';
import { selectionToTsv, tsvToBlock } from './tableClipboard';
import { findHits, hitFileRows, hitKey, replaceAllTarget, HEADER_ROW, type SearchHit } from './tableSearch';
import { SearchBar } from '@/components/workspace/SearchBar';
import { useTableStore } from '@/stores/tableStore';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { FileHistoryDialog } from '@/components/editor/FileHistoryDialog';
import {
  ViewerToolbar,
  ToolbarIconButton,
  ToolbarTextButton,
  ToolbarDivider,
  ToolbarSelect,
} from '@/components/workspace/ViewerToolbar';
import { basename } from '@/lib/paths';

const fmt = (n: number): string => n.toLocaleString('zh-CN', { maximumFractionDigits: 6 });

// ── 行高预设 ──
// 单元格内容是 text-xs（tailwind.config.ts: 11px 字号 / 16px 行高）。
// 每档 = N 行内容高度 + 12px 上下留白（COMPACT 28 = 16 行高 + 12 留白，与旧值一致）。
// ROW_HEIGHT_COMPACT / GUTTER_WIDTH 导出给 XlsxPreview（只读网格与编辑器同视觉规格，单源防漂移）。
const CELL_LINE_HEIGHT = 16; // text-xs 的行高
const CELL_PADDING_Y = 12; // 格内上下留白
export const ROW_HEIGHT_COMPACT = 28; // 1 行（16 + 12）；也是行高下限与默认值
const ROW_HEIGHT_COMFORTABLE = 44; // 2 行（16×2 + 12）
const ROW_HEIGHT_SPACIOUS = 76; // 4 行（16×4 + 12）
const HEADER_HEIGHT = ROW_HEIGHT_COMPACT; // 表头/行号栏恒定紧凑高，不随行高变
const DEFAULT_COL_WIDTH = 120;
const MIN_COL_WIDTH = 56;
export const GUTTER_WIDTH = 48;

/** 该行高能容下几行文本；装不下的交给 line-clamp 收省略号。拖出来的任意行高同样适用。 */
const linesInRow = (rowH: number): number =>
  Math.max(1, Math.floor((rowH - CELL_PADDING_Y) / CELL_LINE_HEIGHT));

/** 行高三档：档位值 + i18n 文案键（label / tooltip）。顺序即工具栏呈现顺序。 */
const ROW_HEIGHT_OPTIONS = [
  { px: ROW_HEIGHT_COMPACT, labelKey: 'rowHeight.compact', tipKey: 'rowHeight.compactTip' },
  { px: ROW_HEIGHT_COMFORTABLE, labelKey: 'rowHeight.comfortable', tipKey: 'rowHeight.comfortableTip' },
  { px: ROW_HEIGHT_SPACIOUS, labelKey: 'rowHeight.spacious', tipKey: 'rowHeight.spaciousTip' },
] as const;

/** 从 prefs 派生初始列宽数组：稀疏 null/undefined 回落默认宽（Task 1 的 columnWidths 可能含 hole）。 */
function colWidthsFromPrefs(prefs: TablePrefs | undefined, colCount: number): number[] {
  const src = prefs?.columnWidths;
  return Array.from({ length: colCount }, (_, i) => {
    const w = src?.[i];
    return typeof w === 'number' && w > 0 ? w : DEFAULT_COL_WIDTH;
  });
}
/** 筛选弹层最多列出的去重值数（超出提示交给 AI） */
const FILTER_VALUE_CAP = 500;

type CellPos = { row: number; col: number }; // row = 文件序下标
type MenuState = { x: number; y: number; fileRow: number | null; col: number };
/** 编辑提交后往哪挪一格（Enter 下 / Tab 右 / 各自的 Shift 反向）；undefined = 原地（失焦提交）。 */
type CellMove = 'down' | 'up' | 'right' | 'left';

// 稳定空默认值：桶未建好时各字段引用恒定，避免每渲染换新 [] / Map 触发无谓重算
const EMPTY_STR: string[] = [];
const EMPTY_ROWS: string[][] = [];
const EMPTY_OPS: never[] = [];
const EMPTY_PROV: never[] = [];
const EMPTY_FILTERS = new Map<number, Set<string>>();
const EMPTY_HITS: SearchHit[] = [];

/**
 * 单个表格面板——右栏标签工作区里的一个 table 标签（path 即标签身份）。
 * 多实例可 keep-mounted 并存，各读 tableStore 自己 path 的桶（排序/筛选/选区/撤销栈互不串）。
 * 文件名与关闭 ✕ 归标签栏；窗口级监听（⌘S/⌘Z/失焦落盘）仅活跃标签绑定。
 */
export function CsvEditor({ path, isActive }: { path: string; isActive: boolean }): JSX.Element | null {
  const { t } = useTranslation('table');
  const tbl = useTableStore((s) => s.tables[path]);
  const restoreFromHistory = useTableStore((s) => s.restoreFromHistory);
  const store = useTableStore.getState;

  const projectId = tbl?.projectId ?? null;
  const headers = tbl?.headers ?? EMPTY_STR;
  const rows = tbl?.rows ?? EMPTY_ROWS;
  const loading = tbl?.loading ?? true;
  const saving = tbl?.saving ?? false;
  const overLimit = tbl?.overLimit ?? false;
  const previewRows = tbl?.previewRows ?? null;
  const totalRows = tbl?.totalRows ?? null;
  const provenance = tbl?.provenance ?? EMPTY_PROV;
  const mtimeMs = tbl?.mtimeMs ?? 0;
  const encodingSafe = tbl?.encodingSafe ?? true;
  const encoding = tbl?.encoding ?? 'utf-8';
  const dirty = tbl?.dirty ?? false;
  const undoStack = tbl?.undoStack ?? EMPTY_OPS;
  const redoStack = tbl?.redoStack ?? EMPTY_OPS;
  const sort = tbl?.sort ?? null;
  const filters = tbl?.filters ?? EMPTY_FILTERS;
  const selection = tbl?.selection ?? null;
  const pendingCanonicalConfirm = tbl?.pendingCanonicalConfirm ?? false;
  const prefs = tbl?.prefs;

  const [historyOpen, setHistoryOpen] = useState(false);
  const [exportPending, setExportPending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportedTo, setExportedTo] = useState<string | null>(null);
  const [editing, setEditing] = useState<(CellPos & { value: string; isHeader?: boolean }) | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  // 粘贴结果的临时告知（挂在底部统计条上）。不走 toast：那是失败专用通道、单一红色样式，
  // 用告警色播报一次成功的粘贴是错的；统计条本就是显示表格状态的地方，零新增视觉元素。
  const [pasteNote, setPasteNote] = useState<{ total: number; hidden: number } | null>(null);
  // ── 查找 / 全部替换 ──
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [activeHit, setActiveHit] = useState(0);
  const [onlyHits, setOnlyHits] = useState(false);
  const [filterCol, setFilterCol] = useState<{ col: number; x: number; y: number } | null>(null);
  const [colWidths, setColWidths] = useState<number[]>([]);
  // 整表默认行高（下拉切档实时改本地，点击时落盘）；来源 = 桶 prefs.rowHeightPx ?? 紧凑
  const [rowHeight, setRowHeight] = useState<number>(ROW_HEIGHT_COMPACT);
  // 拖某行底边时该行的实时高度（拖拽中，未落盘）；null = 无行在拖
  const [dragRow, setDragRow] = useState<{ fileRow: number; px: number } | null>(null);
  const dragSel = useRef<{ r: number; c: number } | null>(null);

  // 超限模式下数据来自 previewRows（[0] 是表头）；可编辑模式来自 store 模型
  const viewHeaders = overLimit ? previewRows?.[0] ?? [] : headers;
  const viewRows = useMemo(
    () => (overLimit ? (previewRows ?? []).slice(1) : rows),
    [overLimit, previewRows, rows],
  );

  const baseIdx = useMemo(() => displayIndexes(viewRows, sort, filters), [viewRows, sort, filters]);

  // 查找命中：坐标存文件行号、顺序是屏幕顺序，所以「只看命中行」二次过滤 displayIdx 之后
  // 命中集合不用重算（存显示序的话两者会互相咬住）。
  const hits = useMemo(
    () => (searchOpen && debouncedQuery ? findHits(viewHeaders, viewRows, baseIdx, debouncedQuery) : EMPTY_HITS),
    [searchOpen, debouncedQuery, viewHeaders, viewRows, baseIdx],
  );
  const hitKeys = useMemo(() => new Set(hits.map((h) => hitKey(h.fileRow, h.col))), [hits]);

  // 「只看命中行」是排序筛选之后的**第二层**行过滤。它必须与 await 后重读的那条派生同源：
  // 选区坐标产生于过滤后的行序，若重读时只算到第一层，反查出来的文件行号会整体错位，
  // Delete / 粘贴会写到别人的行上——静默的数据损坏。故收敛成这一个 filter，两处共用。
  const hitRowSet = useMemo(
    () => (onlyHits && hits.length > 0 ? new Set(hitFileRows(hits)) : null),
    [onlyHits, hits],
  );
  const applyHitFilter = useCallback(
    (idx: number[]): number[] => (hitRowSet ? idx.filter((fileRow) => hitRowSet.has(fileRow)) : idx),
    [hitRowSet],
  );

  const displayIdx = useMemo(() => applyHitFilter(baseIdx), [applyHitFilter, baseIdx]);

  // 切文件：瞬态视图态复位（编辑框/右键菜单/筛选弹层/导出提示）——只随 path，
  // 不能受同文件内偏好提交牵连（否则拖列宽/点档位会误清正打开的弹层或"已导出"提示）。
  useEffect(() => {
    setEditing(null);
    setMenu(null);
    setFilterCol(null);
    setExportedTo(null);
    setDragRow(null); // 拖行高到一半切文件：清实时值，别把旧文件行高糊到新文件同下标行
  }, [path]);

  // 列宽/行高按桶 prefs 初始化：prefs 首次随 open 回执到达（loading→false）时需刷新，故纳入依赖。
  // 同文件内本地拖拽提交会新建 prefs 引用致本 effect 重跑，但 setColWidths/setRowHeight 此刻幂等
  //（值已等于提交值），不会覆盖在途拖拽、也无可感知副作用。
  useEffect(() => {
    setColWidths(colWidthsFromPrefs(prefs, viewHeaders.length));
    setRowHeight(prefs?.rowHeightPx ?? ROW_HEIGHT_COMPACT);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, prefs]);

  const widthOf = useCallback(
    (col: number): number => colWidths[col] ?? DEFAULT_COL_WIDTH,
    [colWidths],
  );

  // 单行取高：拖拽中优先实时值 > 桶内该行覆盖 > 整表默认（rowHeight 已含紧凑回落）。
  const rowHeights = prefs?.rowHeightsPx;
  const rowHeightOf = useCallback(
    (fileRow: number): number => {
      if (dragRow && dragRow.fileRow === fileRow) return dragRow.px;
      return rowHeights?.[fileRow] ?? rowHeight;
    },
    [dragRow, rowHeights, rowHeight],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: displayIdx.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => rowHeightOf(displayIdx[index]!),
    overscan: 12,
  });

  // 行高变化后重新测量——estimateSize 闭包已换、但已缓存的行尺寸需 measure 刷新，否则虚拟项 translateY
  // 仍按旧高排布（行会重叠或留缝）。触发：整表默认切档、单行拖拽实时值、桶内覆盖落定、排序/筛选致
  // displayIdx 重排（同一显示位换了 fileRow → 高度随之变）。
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, dragRow, rowHeights, displayIdx, virtualizer]);

  // ── 键盘操作 ──
  // 退出编辑一律经这里回焦容器：焦点留在即将卸载的 input 上，方向键之后就全哑了。
  const exitEdit = useCallback(() => {
    setEditing(null);
    scrollRef.current?.focus();
  }, []);

  // 两道只读门槛行为一致：Dialog 不做焦点陷阱（遮罩只挡鼠标），
  // 转规范确认框开着时容器照样收得到键盘事件，不显式挡就能改。
  const readonly = overLimit || pendingCanonicalConfirm;

  /** 编辑提交后按方向挪一格（入参是文件行号，转回显示序再走）。 */
  const moveFrom = useCallback(
    (fileRow: number, col: number, move: CellMove) => {
      const cur = displayIdx.indexOf(fileRow);
      if (cur < 0) return;
      const r = Math.max(0, Math.min(cur + (move === 'down' ? 1 : move === 'up' ? -1 : 0), displayIdx.length - 1));
      const c = Math.max(0, Math.min(col + (move === 'right' ? 1 : move === 'left' ? -1 : 0), viewHeaders.length - 1));
      store().setSelection(path, { kind: 'range', r1: r, c1: c, r2: r, c2: c });
      virtualizer.scrollToIndex(r);
    },
    [displayIdx, viewHeaders.length, store, path, virtualizer],
  );

  // 剪贴板三件套。**每个 await 之后一律从 store 重读**——navigator.clipboard 是异步的，
  // 这期间 AI 落盘会触发 syncFromDisk 把 headers/rows 整体换掉，用 keydown 那一刻闭包捕获的
  // displayIdx 去算文件行号会写到错的行上。选区、排序、筛选同样重读，全部基于 await 之后的事实。
  const currentView = useCallback(() => {
    const t = store().tables[path];
    if (!t) return null;
    const rows = t.overLimit ? (t.previewRows ?? []).slice(1) : t.rows;
    // 两层都要重算：排序筛选（store 里的事实）+ 只看命中行（组件态），与渲染同源
    return { t, rows, idx: applyHitFilter(displayIndexes(rows, t.sort, t.filters)) };
  }, [store, path, applyHitFilter]);

  const doCopy = useCallback(async () => {
    const cur = currentView();
    if (!cur) return;
    const tsv = selectionToTsv(cur.rows, cur.idx, cur.t.selection);
    if (!tsv) return;
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      toastError(t('csv.clipboardFailed'));
    }
  }, [currentView, t]);

  /** 清空当前选区（剪切的后半段、Delete 的全部）。入参是 await 之后重读到的视图。 */
  const clearSelection = useCallback(() => {
    const cur = currentView();
    if (!cur || cur.t.overLimit || cur.t.pendingCanonicalConfirm) return;
    const sel = cur.t.selection;
    if (!sel || sel.kind === 'col') return;
    const { r1, c1, r2, c2 } = normalizeRange(sel);
    const fileRows: number[] = [];
    for (let r = r1; r <= r2; r++) {
      const fileRow = cur.idx[r];
      if (fileRow !== undefined) fileRows.push(fileRow);
    }
    if (fileRows.length) store().clearBlock(path, fileRows, c1, c2 - c1 + 1);
  }, [currentView, store, path]);

  const doCut = useCallback(async () => {
    const cur = currentView();
    if (!cur) return;
    const tsv = selectionToTsv(cur.rows, cur.idx, cur.t.selection);
    if (!tsv) return;
    try {
      await navigator.clipboard.writeText(tsv);
    } catch {
      toastError(t('csv.clipboardFailed'));
      return; // 复制失败就不清空——两步都成才算剪切
    }
    clearSelection();
  }, [currentView, clearSelection, t]);

  const doPaste = useCallback(async () => {
    let text: string;
    try {
      text = await navigator.clipboard.readText();
    } catch {
      toastError(t('csv.clipboardFailed'));
      return;
    }
    if (!text) return;
    const cur = currentView();
    if (!cur || cur.t.overLimit || cur.t.pendingCanonicalConfirm) return;
    const sel = cur.t.selection;
    if (!sel || sel.kind === 'col') return;
    const { r1, c1, r2, c2 } = normalizeRange(sel); // 落点是左上角，不是拖拽锚点
    const target = tsvToBlock(text, cur.idx, cur.rows.length, { r: r1, c: c1 }, { rows: r2 - r1 + 1, cols: c2 - c1 + 1 });
    if (!target) return;
    if (!store().writeBlock(path, target.rows, target.col, target.block)) {
      toastError(t('csv.pasteTooBig'));
      return;
    }
    // 追加的行落在文件末尾；有筛选时它们当前不可见，用户没法在屏幕上验证刚粘的东西
    if (target.appended > 0 && cur.t.filters.size > 0) {
      setPasteNote({ total: target.block.length, hidden: target.appended });
    }
  }, [currentView, store, path, t]);

  // 告知几秒后自行退场（注册与清理同处）
  useEffect(() => {
    if (!pasteNote) return;
    const timer = setTimeout(() => setPasteNote(null), 6000);
    return () => clearTimeout(timer);
  }, [pasteNote]);

  // 输入停手才扫全表：十万行 × N 列的逐格 indexOf 不该每敲一个字符跑一遍
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => setActiveHit(0), [debouncedQuery]);

  /** 跳到第 i 个命中：选中它并滚进视野。表头是 sticky 的，一直可见、不必滚。 */
  const gotoHit = useCallback(
    (i: number) => {
      const hit = hits[i];
      if (!hit) return;
      setActiveHit(i);
      if (hit.fileRow === HEADER_ROW) return;
      const displayRow = displayIdx.indexOf(hit.fileRow);
      if (displayRow < 0) return;
      store().setSelection(path, { kind: 'range', r1: displayRow, c1: hit.col, r2: displayRow, c2: hit.col });
      virtualizer.scrollToIndex(displayRow);
    },
    [hits, displayIdx, store, path, virtualizer],
  );

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setQuery('');
    setDebouncedQuery('');
    setOnlyHits(false); // 关面板就撤掉这层过滤，否则表看着「少了行」却找不到原因
    scrollRef.current?.focus();
  }, []);

  const doReplaceAll = useCallback(() => {
    const cur = currentView();
    if (!cur || cur.t.overLimit || cur.t.pendingCanonicalConfirm || !debouncedQuery) return;
    // 用当前视图重算一遍命中：面板开着期间 AI 可能已落盘改表
    const fresh = findHits(cur.t.headers, cur.rows, cur.idx, debouncedQuery);
    const target = replaceAllTarget(fresh, cur.rows, debouncedQuery, replacement);
    if (!target) return;
    if (!store().writeBlock(path, target.rows, target.col, target.block)) {
      toastError(t('csv.pasteTooBig'));
      return;
    }
    // 焦点交回表格：留在替换框里的话，紧接着按 ⌘Z 会被 window 层的 inInput 守卫放行给输入框，
    // 撤销的是刚才输入的字而不是这次替换——而「改错一键回退」正是 UI 替换敢做的前提。
    scrollRef.current?.focus();
  }, [currentView, debouncedQuery, replacement, store, path, t]);

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const action = resolveTableKey(e, {
        selection,
        rowCount: displayIdx.length,
        colCount: viewHeaders.length,
        readonly,
        editing: editing !== null,
      });
      if (!action) return; // null = 放行（编辑态、⌘S/⌘Z 等）
      e.preventDefault();
      switch (action.kind) {
        case 'select':
          store().setSelection(path, action.sel);
          if (action.sel?.kind === 'range') virtualizer.scrollToIndex(action.sel.r2);
          break;
        case 'edit': {
          const fileRow = displayIdx[action.row];
          if (fileRow === undefined) break;
          // initial=null（⌃U/F2）保留原值；否则以刚敲的那个字符覆盖
          setEditing({ row: fileRow, col: action.col, value: action.initial ?? viewRows[fileRow]?.[action.col] ?? '' });
          break;
        }
        case 'clear':
          clearSelection(); // 筛选态下清的是屏幕上那几行对应的文件行
          break;
        case 'copy':
          void doCopy();
          break;
        case 'cut':
          void doCut();
          break;
        case 'paste':
          void doPaste();
          break;
      }
    },
    [
      selection,
      displayIdx,
      viewHeaders.length,
      viewRows,
      readonly,
      editing,
      store,
      path,
      virtualizer,
      clearSelection,
      doCopy,
      doCut,
      doPaste,
    ],
  );

  // ⌘S 实时落盘下还原成「立刻留个底」（manual 快照）
  const manualSnapshot = useCallback(() => void store().manualSnapshot(path), [store, path]);

  // 全局快捷键：⌘S 留底、⌘Z 撤销、⇧⌘Z 重做（编辑格内时让 input 自己处理）。仅活跃标签绑。
  useEffect(() => {
    if (!isActive) return;
    function onKeyDown(e: KeyboardEvent): void {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        manualSnapshot();
        return;
      }
      const target = e.target as HTMLElement | null;
      const inInput = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (inInput) return;
      // ⌘F 与 ⌘Z 同层（window + isActive + 不在输入框里）。必须在 inInput 之后：
      // 它打开的查找条带 autoFocus，会把焦点从对话输入框抢走，而「表格标签活跃」与
      // 「用户正在对话框里打字」可以同时为真；在格内编辑时按也会 blur 掉这次编辑。
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) store().redo(path);
        else store().undo(path);
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive, path, manualSnapshot, store]);

  // 失焦/隐藏立即落盘（与编辑器一致）；切回/可见的刷新走 bindTableEvents 的 fs.changed→syncFromDisk。仅活跃标签绑。
  useEffect(() => {
    if (!isActive) return;
    const onBlur = (): void => void store().flush(path);
    const onVisible = (): void => {
      if (document.visibilityState === 'hidden') void store().flush(path);
    };
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [isActive, path, store]);

  // 导出：有草稿先保存（确认版才出境）；保存完成（且无规范确认挂起）后续跑导出
  const doExport = useCallback(async () => {
    if (!projectId || exporting) return;
    setExporting(true);
    try {
      const r = await wsClient.request<TableExportedEvent>({
        type: 'table.exportXlsx',
        projectId,
        path,
      });
      if (!r.xlsxPath) return; // 用户在保存对话框取消：不动已有提示
      setExportedTo(r.xlsxPath);
    } catch {
      setExportedTo(null);
    } finally {
      setExporting(false);
    }
  }, [projectId, path, exporting]);

  useEffect(() => {
    if (exportPending && !dirty && !pendingCanonicalConfirm && !saving && encodingSafe) {
      setExportPending(false);
      void doExport();
    }
  }, [exportPending, dirty, pendingCanonicalConfirm, saving, encodingSafe, doExport]);

  const handleExport = useCallback(() => {
    // 导出的是磁盘版——实时落盘下先 flush 把 pending 落地，再导出
    if (!encodingSafe) {
      // 编码不安全（GBK / BOM）时先过转换确认（验收 7），转换完成后续跑导出——判据与保存同一条：
      // 只有不可逆的编码转换值得用户拍板。风格差异（多余引号 / CRLF）不拦：它无损、导出照样正确，
      // 拦它只是让用户在导出前被问一句他无从判断的话（保存那条路已经不问了，两处不该一严一宽）。
      store().requestCanonicalConfirm(path);
      setExportPending(true);
      return;
    }
    void store()
      .flush(path)
      .then(() => doExport());
  }, [encodingSafe, store, path, doExport]);

  if (!tbl) return null; // 桶还没建好（open 在途）

  const filteredInfo = filters.size > 0;
  // 超限模式不给统计：对前 1,000 行预览求和是误导（统计条只报总行数）
  const stats = overLimit ? null : computeStatsForSelection(viewRows, displayIdx, selection);

  return (
    <div data-aside-region="editor" className="flex h-full flex-col">
      {/* 双行壳工具条行（A1）：路径面包屑归 ViewerToolbar；右侧 = 撤销/重做/历史（图标）| 导出（文字，核心动作置最右） */}
      <ViewerToolbar path={path}>
        {exportedTo && (
          <button
            type="button"
            title={t('csv.revealExport')}
            className="mr-1 truncate text-xs text-success hover:underline"
            onClick={() => {
              if (projectId) void wsClient.request({ type: 'table.revealExport', projectId, path: exportedTo });
            }}
          >
            {t('csv.exported', { name: basename(exportedTo) })}
          </button>
        )}
        <ToolbarIconButton
          title={t('csv.undo')}
          disabled={undoStack.length === 0 || overLimit}
          onClick={() => store().undo(path)}
        >
          <Undo2 className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </ToolbarIconButton>
        <ToolbarIconButton
          title={t('csv.redo')}
          disabled={redoStack.length === 0 || overLimit}
          onClick={() => store().redo(path)}
        >
          <Redo2 className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </ToolbarIconButton>
        <ToolbarIconButton title={t('csv.history')} onClick={() => setHistoryOpen(true)}>
          <History className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </ToolbarIconButton>
        <ToolbarIconButton title={t('search.open')} onClick={() => setSearchOpen((v) => !v)}>
          <Search className="h-[13px] w-[13px]" strokeWidth={1.5} />
        </ToolbarIconButton>
        <ToolbarDivider />
        {/* 行高三档下拉：选中立即落盘（离散动作）；当前行高恰为某档时打勾，拖拽出的中间值回落「自定义」 */}
        <ToolbarSelect
          icon={Rows3}
          title={t('rowHeight.label')}
          fallbackLabel={t('rowHeight.custom')}
          options={ROW_HEIGHT_OPTIONS.map((o) => ({
            value: String(o.px),
            label: t(o.labelKey),
            title: t(o.tipKey),
          }))}
          value={String(rowHeight)}
          onChange={(v) => {
            const px = Number(v);
            setRowHeight(px);
            store().commitRowHeight(path, px, { immediate: true });
          }}
        />
        <ToolbarDivider />
        <ToolbarTextButton
          title={overLimit ? t('csv.exportOverLimit') : t('csv.exportXlsx')}
          disabled={overLimit || exporting}
          onClick={handleExport}
        >
          {exporting ? (
            <Loader2 className="h-[13px] w-[13px] animate-spin" strokeWidth={1.5} />
          ) : (
            <Download className="h-[13px] w-[13px]" strokeWidth={1.5} />
          )}
          <span>{t('csv.export')}</span>
        </ToolbarTextButton>
      </ViewerToolbar>

      {/* 查找条：独立一条而非塞进工具栏——带替换输入框是两行的量，工具栏那一行装不下 */}
      {searchOpen && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-sunken/50 px-3 py-1.5">
          <SearchBar
            query={query}
            count={hits.length}
            active={activeHit}
            onQuery={setQuery}
            onPrev={() => gotoHit((activeHit - 1 + hits.length) % Math.max(1, hits.length))}
            onNext={() => gotoHit((activeHit + 1) % Math.max(1, hits.length))}
            onClose={closeSearch}
            t={t}
          />
          {!readonly && (
            <>
              <input
                value={replacement}
                placeholder={t('csv.replacePlaceholder')}
                onChange={(e) => setReplacement(e.target.value)}
                className="w-40 rounded-lg border border-border bg-elevated px-2 py-1 text-xs text-text-primary outline-none focus:border-accent focus:ring-2 focus:ring-accent-ring"
              />
              <ToolbarTextButton title={t('csv.replaceAllTip')} disabled={hits.length === 0} onClick={doReplaceAll}>
                <span>{t('csv.replaceAll')}</span>
              </ToolbarTextButton>
            </>
          )}
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-text-secondary">
            <input type="checkbox" checked={onlyHits} onChange={(e) => setOnlyHits(e.target.checked)} />
            {t('csv.onlyHits')}
          </label>
        </div>
      )}

      {/* 来源条：纯信息展示，不带任何按钮（刷新走对话） */}
      {provenance.length === 1 && (
        <div className="shrink-0 border-b border-border bg-sunken/50 px-3 py-1.5 text-xs text-text-secondary">
          <Trans
            t={t}
            i18nKey="csv.provBy"
            values={{ script: provenance[0]!.script }}
            components={{ em: <span className="text-text-primary"></span> }}
          />
          {provenance[0]!.source ? (
            <Trans
              t={t}
              i18nKey="csv.provSource"
              values={{ source: provenance[0]!.source }}
              components={{ em: <span className="text-text-primary"></span> }}
            />
          ) : null}
          {mtimeMs > 0 ? <> · {new Date(mtimeMs).toLocaleString('zh-CN')}</> : null}
        </div>
      )}
      {provenance.length > 1 && (
        <div className="shrink-0 border-b border-border bg-sunken/50 px-3 py-1.5 text-xs text-text-secondary">
          {t('csv.provMulti', { scripts: provenance.map((p) => p.script).join(t('common:listSeparator')) })}
        </div>
      )}

      {/* 超限只读提示（B3）：琥珀 warn 警示色 + 光晕点 + 右侧「撤销/导出已禁用」注记 */}
      {overLimit && (
        <div className="flex shrink-0 items-center gap-2 border-b border-warn-soft bg-warn-soft px-3.5 py-1.5 text-xs text-warn-deep">
          <span className="h-2 w-2 shrink-0 rounded-full bg-warn shadow-[0_0_0_3px_var(--warn-soft)]" />
          <span className="min-w-0">{t('csv.overLimit')}</span>
          <span className="ml-auto shrink-0 text-warn">{t('csv.overLimitDisabled')}</span>
        </div>
      )}

      {/* 表格主体 */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-text-tertiary">{t('common:loading')}</div>
        ) : viewHeaders.length === 0 && viewRows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-xs text-text-tertiary">
            <span>{t('csv.emptyTable')}</span>
            <Button size="sm" onClick={() => store().insertCol(path, 0)}>
              {t('csv.addFirstCol')}
            </Button>
          </div>
        ) : (
          // tabIndex 是键盘操作的地基：keydown 只从聚焦元素往上冒泡，容器不可聚焦就一个键都收不到。
          // 挂容器而非 window 的理由是**焦点作用域**——无修饰键的方向键和可打印字符不能全局抢，
          // 否则焦点在对话输入框时打字会跑进表格。（多标签隔离另有 isActive 管，见下方 window 层。）
          <div
            ref={scrollRef}
            tabIndex={-1}
            onKeyDown={handleKeyDown}
            className="oru-table-scroll h-full overflow-auto outline-none"
            onMouseUp={() => (dragSel.current = null)}
          >
            {/* 表头（sticky） */}
            <div
              className="sticky top-0 z-10 flex border-b border-border bg-elevated"
              style={{ width: GUTTER_WIDTH + viewHeaders.reduce((a, _, i) => a + widthOf(i), 0) }}
            >
              <div
                className="shrink-0 border-r border-border bg-elevated"
                style={{ width: GUTTER_WIDTH, height: HEADER_HEIGHT }}
              />
              {viewHeaders.map((h, c) => (
                <HeaderCell
                  key={c}
                  label={h.trim() === '' ? t('csv.colN', { n: c + 1 }) : h}
                  placeholder={h.trim() === ''}
                  width={widthOf(c)}
                  sorted={sort?.col === c ? (sort.asc ? 'asc' : 'desc') : null}
                  selected={selection?.kind === 'col' && selection.col === c}
                  filtered={filters.has(c)}
                  hit={hitKeys.has(hitKey(HEADER_ROW, c))}
                  readonly={overLimit}
                  onClick={() => store().cycleSort(path, c)}
                  onDoubleClick={() => {
                    if (!overLimit) setEditing({ row: -1, col: c, value: h, isHeader: true });
                  }}
                  onFilterClick={(x, y) => setFilterCol({ col: c, x, y })}
                  onContextMenu={(x, y) => {
                    if (!overLimit) setMenu({ x, y, fileRow: null, col: c });
                  }}
                  onResize={(w) =>
                    setColWidths((prev) => {
                      const next = prev.slice();
                      next[c] = Math.max(MIN_COL_WIDTH, w);
                      return next;
                    })
                  }
                  onResizeEnd={(w) => {
                    // 拖拽结束才落盘（过程只走本地 state，不逐帧写）。w 是本列最终宽度（拖拽内核传入，
                    // 不读 stale closure）；其余列本次未变、读当前 widthOf 即可，补齐所有列避免稀疏 hole。
                    const widths = viewHeaders.map((_, i) => (i === c ? w : widthOf(i)));
                    store().commitColumnWidths(path, widths);
                  }}
                  editing={editing?.isHeader === true && editing.col === c ? editing.value : null}
                  onEditChange={(v) => setEditing((e) => (e ? { ...e, value: v } : e))}
                  onEditCommit={() => {
                    if (editing) store().editHeader(path, editing.col, editing.value);
                    exitEdit();
                  }}
                  onEditCancel={exitEdit}
                />
              ))}
            </div>

            {/* 虚拟行 */}
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((vi) => {
                const fileRow = displayIdx[vi.index]!;
                const row = viewRows[fileRow]!;
                const rowH = rowHeightOf(fileRow);
                // 该行高于紧凑档 → 单元格多行截断（顶端对齐）；紧凑维持单行 truncate
                const multiLine = rowH > ROW_HEIGHT_COMPACT;
                return (
                  <div
                    key={vi.key}
                    className={cn('absolute left-0 flex', vi.index % 2 === 1 && 'bg-sunken/30')}
                    style={{ transform: `translateY(${vi.start}px)`, height: rowH }}
                  >
                    <div
                      className="group/gutter relative flex shrink-0 items-start justify-end border-b border-r border-border pr-2 pt-1.5 text-2xs tabular-nums text-text-tertiary"
                      style={{ width: GUTTER_WIDTH }}
                    >
                      {fileRow + 1}
                      {/* 行高拖拽把手：拖某行底边只改这一行（单行覆盖，仿列宽拖拽），mouseup 落盘。
                          上限取表格可视区高度——单行覆盖没有重置入口，拖到超过一屏就再也抓不到把手了 */}
                      {!overLimit && (
                        <div
                          className="absolute inset-x-0 -bottom-0.5 z-10 h-1.5 cursor-row-resize opacity-0 group-hover/gutter:opacity-100"
                          onMouseDown={(e) =>
                            startRowResize(
                              e,
                              rowH,
                              Math.max(ROW_HEIGHT_SPACIOUS, (scrollRef.current?.clientHeight ?? 0) - HEADER_HEIGHT),
                              (px) => setDragRow({ fileRow, px }),
                              (px) => {
                                setDragRow(null);
                                store().commitRowHeightAt(path, fileRow, px);
                              },
                            )
                          }
                        />
                      )}
                    </div>
                    {viewHeaders.map((_, c) => {
                      const isEditing = editing && !editing.isHeader && editing.row === fileRow && editing.col === c;
                      const inSelection = isCellSelected(selection, vi.index, c);
                      return (
                        <div
                          key={c}
                          className={cn(
                            'flex overflow-hidden border-b border-r border-border px-2 text-xs text-text-secondary',
                            // 紧凑=垂直居中单行；放大=顶端对齐多行（内容超出行高截断）
                            multiLine ? 'items-start pt-1.5' : 'items-center',
                            inSelection && !isEditing && 'bg-accent-soft text-text-primary',
                            // 查找命中用**描边**不用底色：选中格已经是 bg-accent-soft，
                            // 再用底色就分不清「我选的」和「搜到的」。当前命中由选区本身表达（跳转即设选区）。
                            hitKeys.has(hitKey(fileRow, c)) && !isEditing && 'ring-1 ring-inset ring-accent',
                            // 编辑态：格子四条边线亮起（lamp-line 聚焦边线 token，内缩贴边盖住底/右灰网格线），
                            // z-10 让四边压过相邻格网格线；输入框无边框透明，只此一层亮
                            isEditing &&
                              'relative z-10 bg-canvas text-text-primary outline outline-[1.5px] -outline-offset-[1px] outline-lamp-line',
                          )}
                          style={{ width: widthOf(c) }}
                          onMouseDown={(e) => {
                            if (e.button !== 0 || isEditing) return;
                            scrollRef.current?.focus(); // 点了格子键盘就该能用——格子本身不可聚焦，焦点收在容器
                            dragSel.current = { r: vi.index, c };
                            store().setSelection(path, { kind: 'range', r1: vi.index, c1: c, r2: vi.index, c2: c });
                          }}
                          onMouseEnter={() => {
                            const anchor = dragSel.current;
                            if (!anchor) return;
                            // 存锚点 + 焦点，不在这里规范化——Shift+方向扩选要知道从哪一端扩，
                            // 存进去就 min/max 会把方向信息抹掉。归一化统一交给 normalizeRange。
                            store().setSelection(path, { kind: 'range', r1: anchor.r, c1: anchor.c, r2: vi.index, c2: c });
                          }}
                          onDoubleClick={() => {
                            if (!overLimit) setEditing({ row: fileRow, col: c, value: row[c] ?? '' });
                          }}
                          onContextMenu={(e: ReactMouseEvent) => {
                            e.preventDefault();
                            if (!overLimit) setMenu({ x: e.clientX, y: e.clientY, fileRow, col: c });
                          }}
                        >
                          {isEditing ? (
                            <CellInput
                              value={editing.value}
                              multiLine={multiLine}
                              onChange={(v) => setEditing((p) => (p ? { ...p, value: v } : p))}
                              onCommit={(move) => {
                                store().editCell(path, editing.row, editing.col, editing.value);
                                exitEdit();
                                if (move) moveFrom(editing.row, editing.col, move);
                              }}
                              onCancel={exitEdit}
                            />
                          ) : (
                            // 全档真分行：格内的换行符按换行显示，装不下的部分由 line-clamp 收省略号。
                            // 省略号对「没有换行符的长文本」同样生效——旧的多行分支是硬切，看不出还有没有内容。
                            <span
                              className="whitespace-pre-wrap break-words"
                              style={{
                                display: '-webkit-box',
                                WebkitBoxOrient: 'vertical',
                                WebkitLineClamp: linesInRow(rowH),
                                overflow: 'hidden',
                              }}
                            >
                              {row[c] ?? ''}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* 统计条（Excel 右下角的肌肉记忆） */}
      <div className="flex h-7 shrink-0 items-center justify-between gap-3 border-t border-border bg-elevated/60 px-3 text-xs text-text-tertiary">
        <div className="flex items-center gap-3">
          {overLimit ? (
            <span>{totalRows === null ? t('csv.totalCounting') : t('csv.totalRows', { count: fmt(totalRows) })}</span>
          ) : (
            <span>
              {t('csv.dims', { rows: fmt(viewRows.length), cols: viewHeaders.length })}
              {/* 只标编码：风格不规范会在下次保存时无损定型、用户也无从下手，标它等于指着一个
                  没有动作可做的非问题。GBK/BOM 才是真要用户知道的——它解释了为什么 Oru 动这张表
                  会停下来问、以及为什么会弹一张不可逆转换的确认卡。 */}
              {!encodingSafe ? t('csv.nonUtf8') : ''}
            </span>
          )}
          {filteredInfo && !overLimit && (
            <span className="flex items-center gap-1">
              {t('csv.filtered', { shown: fmt(displayIdx.length), total: fmt(viewRows.length) })}
              <button
                type="button"
                className="underline hover:text-text-secondary"
                onClick={() => {
                  for (const col of [...filters.keys()]) store().setFilter(path, col, null);
                }}
              >
                {t('csv.clearFilter')}
              </button>
            </span>
          )}
          {/* 粘贴溢出的如实告知：追加的行落在文件末尾、当前筛选下看不见，用户没法在屏幕上验证 */}
          {pasteNote && (
            <span className="text-text-secondary">
              {t('csv.pasteHidden', { total: pasteNote.total, count: pasteNote.hidden })}
            </span>
          )}
        </div>
        {stats && (
          <div className="flex items-center gap-3 tabular-nums">
            <span>{t('csv.statCount', { n: fmt(stats.count) })}</span>
            {stats.sum !== null && <span>{t('csv.statSum', { n: fmt(stats.sum) })}</span>}
            {stats.avg !== null && <span>{t('csv.statAvg', { n: fmt(stats.avg) })}</span>}
            {stats.sum !== null && stats.ignored > 0 && <span>{t('csv.statIgnored', { n: stats.ignored })}</span>}
          </div>
        )}
      </div>

      {/* 右键菜单 */}
      {menu && (
        <TableContextMenu
          menu={menu}
          onClose={() => setMenu(null)}
          onAction={(action) => {
            const s = store();
            const { fileRow, col } = menu;
            if (action === 'insertRowAbove' && fileRow !== null) s.insertRow(path, fileRow);
            else if (action === 'insertRowBelow' && fileRow !== null) s.insertRow(path, fileRow + 1);
            else if (action === 'deleteRow' && fileRow !== null) s.deleteRow(path, fileRow);
            else if (action === 'insertColLeft') s.insertCol(path, col);
            else if (action === 'insertColRight') s.insertCol(path, col + 1);
            else if (action === 'deleteCol') s.deleteCol(path, col);
            setMenu(null);
          }}
        />
      )}

      {/* 筛选弹层 */}
      {filterCol && (
        <FilterPopover
          x={filterCol.x}
          y={filterCol.y}
          values={distinctValues(viewRows, filterCol.col)}
          selected={filters.get(filterCol.col) ?? null}
          onApply={(set) => {
            store().setFilter(path, filterCol.col, set);
            setFilterCol(null);
          }}
          onClose={() => setFilterCol(null)}
        />
      )}

      <FileHistoryDialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        docRef={projectId && path ? { kind: 'project', projectId, path } : null}
        currentContent={serializeCsv({ headers, rows })}
        onRestore={(snapshotId) => restoreFromHistory(path, snapshotId)}
      />

      {/* 编码不安全的文件：转规范 / 另存副本（验收 7：确认之前原件逐字节不变）。
          这个框现在只为编码而弹（风格不规范已不拦保存也不拦导出），描述按两种编码问题分——
          GBK 与「UTF-8 带 BOM」都会到这里，后者 encoding 仍是 'utf-8'，不能落到风格文案上。 */}
      <Dialog
        open={pendingCanonicalConfirm}
        onClose={() => {
          setExportPending(false);
          store().dismissCanonicalConfirm(path);
        }}
        title={t('canonical.title')}
        description={encoding === 'gbk' ? t('csv.gbkDesc') : t('csv.bomDesc')}
        footer={
          <div className="flex w-full items-center justify-end gap-2">
            <Button
              onClick={() => {
                setExportPending(false);
                store().dismissCanonicalConfirm(path);
              }}
            >
              {t('common:cancel')}
            </Button>
            <Button onClick={() => void store().resolveCanonical(path, 'saveCopy')}>
              {t('canonical.saveCopy')}
            </Button>
            <Button variant="primary" onClick={() => void store().resolveCanonical(path, 'convert')}>
              {t('canonical.convert')}
            </Button>
          </div>
        }
      >
        <span className="text-sm text-text-secondary">{basename(path)}</span>
      </Dialog>
    </div>
  );
}

function distinctValues(rows: string[][], col: number): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    seen.add(row[col] ?? '');
    if (seen.size > FILTER_VALUE_CAP) break;
  }
  return [...seen].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

function CellInput({
  value,
  onChange,
  onCommit,
  onCancel,
  multiLine = false,
}: {
  value: string;
  onChange: (v: string) => void;
  /** move 由**按键**给出而非靠事件冒泡时序推断：失焦提交不带 move、Enter/Tab 各自带方向 */
  onCommit: (move?: CellMove) => void;
  onCancel: () => void;
  /** 行高高于紧凑档时改用 textarea：Enter 提交、Shift+Enter 插入换行；表头恒为单行 input（不传） */
  multiLine?: boolean;
}): JSX.Element {
  // 无边框透明填满格子（四边亮起交给外层格子的 accent outline）；px-0 使编辑文字与显示文字左缘对齐
  const className =
    'w-full border-0 bg-transparent px-0 text-xs text-text-primary caret-accent outline-none';

  // Esc/Enter 触发 cancel/commit 会 setEditing(null) 卸载本元素，卸载引发的 blur 又会打到 onBlur——
  // done 守卫让「提交/取消」每次编辑只生效一次，否则 Esc 取消后的那次 blur 会把想丢弃的值又提交回去。
  const done = useRef(false);
  const commit = (move?: CellMove): void => {
    if (done.current) return;
    done.current = true;
    onCommit(move);
  };
  const cancel = (): void => {
    if (done.current) return;
    done.current = true;
    onCancel();
  };

  if (multiLine) {
    return (
      <textarea
        // eslint-disable-next-line jsx-a11y/no-autofocus
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
          if (e.key === 'Enter' && !e.shiftKey) {
            // 裸 Enter 提交并下移；Shift+Enter 交给 textarea 默认插入 \n（不拦截）
            e.preventDefault();
            commit('down');
          } else if (e.key === 'Tab') {
            e.preventDefault();
            commit(e.shiftKey ? 'left' : 'right');
          } else if (e.key === 'Escape') {
            e.preventDefault();
            cancel();
          }
        }}
        // resize-none：编辑框与格子同高，不出现浏览器右下角拖拽柄；py-0 顶端与格内多行显示文字对齐
        className={cn(className, 'h-full resize-none py-0 leading-4 align-top')}
      />
    );
  }

  return (
    <input
      // eslint-disable-next-line jsx-a11y/no-autofocus
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.nativeEvent.isComposing) return; // 输入法选词态回车不提交
        if (e.key === 'Enter') {
          e.preventDefault();
          commit('down');
        } else if (e.key === 'Tab') {
          e.preventDefault();
          commit(e.shiftKey ? 'left' : 'right');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      className={className}
    />
  );
}

/**
 * 行高拖拽内核：拖动实时回报高度（onResize，调用方决定改整表还是单行），clamp 到 [紧凑, maxH]，
 * mouseup 落盘（onResizeEnd）。与 HeaderCell.startResize 同构——window mousemove/mouseup 成对注册与清理。
 */
function startRowResize(
  e: ReactMouseEvent,
  startH: number,
  maxH: number,
  onResize: (px: number) => void,
  onResizeEnd: (px: number) => void,
): void {
  e.preventDefault();
  e.stopPropagation();
  const startY = e.clientY;
  let latest = startH;
  function onMove(ev: MouseEvent): void {
    latest = Math.max(ROW_HEIGHT_COMPACT, Math.min(maxH, startH + (ev.clientY - startY)));
    onResize(latest);
  }
  function onUp(): void {
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
    onResizeEnd(latest);
  }
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
}

function HeaderCell({
  label,
  placeholder,
  width,
  sorted,
  selected,
  filtered,
  hit,
  readonly,
  onClick,
  onDoubleClick,
  onFilterClick,
  onContextMenu,
  onResize,
  onResizeEnd,
  editing,
  onEditChange,
  onEditCommit,
  onEditCancel,
}: {
  label: string;
  placeholder: boolean;
  width: number;
  sorted: 'asc' | 'desc' | null;
  selected: boolean;
  filtered: boolean;
  /** 查找命中（描边表达，与选中的底色正交） */
  hit: boolean;
  readonly: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onFilterClick: (x: number, y: number) => void;
  onContextMenu: (x: number, y: number) => void;
  onResize: (w: number) => void;
  onResizeEnd: (w: number) => void;
  editing: string | null;
  onEditChange: (v: string) => void;
  onEditCommit: () => void;
  onEditCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation('table');
  function startResize(e: ReactMouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = width;
    // latestW 跟踪最新宽度，onUp 传值给 onResizeEnd——不能靠 state closure：
    // onUp 在 mousedown 帧注册，关住的 onResizeEnd 读的是拖前 colWidths（否则落盘的是拖前宽度）。
    let latestW = startW;
    function onMove(ev: MouseEvent): void {
      latestW = Math.max(MIN_COL_WIDTH, startW + (ev.clientX - startX));
      onResize(latestW);
    }
    function onUp(): void {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      onResizeEnd(latestW);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  return (
    <div
      className={cn(
        'group relative flex shrink-0 cursor-default items-center gap-1 border-r border-border px-2 text-xs font-medium',
        // 编辑态与数据格一致：四条边线亮起（lamp-line 聚焦边线 token，内缩贴边），z-20 压过相邻表头格
        editing !== null
          ? 'z-20 bg-canvas text-text-primary outline outline-[1.5px] -outline-offset-[1px] outline-lamp-line'
          : selected
            ? 'bg-accent-soft text-text-primary'
            : 'text-text-secondary hover:bg-hover',
        hit && editing === null && 'ring-1 ring-inset ring-accent',
      )}
      style={{ width, height: HEADER_HEIGHT }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      {editing !== null ? (
        <CellInput value={editing} onChange={onEditChange} onCommit={onEditCommit} onCancel={onEditCancel} />
      ) : (
        <>
          <span className={cn('truncate', placeholder && 'italic text-text-tertiary')}>{label}</span>
          {sorted === 'asc' && <ArrowUpNarrowWide className="h-3 w-3 shrink-0 text-accent" strokeWidth={1.5} />}
          {sorted === 'desc' && <ArrowDownWideNarrow className="h-3 w-3 shrink-0 text-accent" strokeWidth={1.5} />}
          {/* 第三态（无序）：hover 才浮现的中性双向箭头，提示该列可排序（B3 排序三态视觉补齐） */}
          {sorted === null && !readonly && (
            <ChevronsUpDown className="h-3 w-3 shrink-0 text-text-quaternary opacity-0 group-hover:opacity-100" strokeWidth={1.5} />
          )}
          <span className="ml-auto flex items-center">
            <button
              type="button"
              title={t('csv.filter')}
              className={cn(
                'flex h-4 w-4 items-center justify-center rounded',
                filtered ? 'text-accent' : 'text-text-tertiary opacity-0 hover:text-text-secondary group-hover:opacity-100',
              )}
              onClick={(e) => {
                e.stopPropagation();
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                onFilterClick(rect.left, rect.bottom + 4);
              }}
            >
              <Filter className="h-3 w-3" strokeWidth={1.5} />
            </button>
          </span>
        </>
      )}
      {!readonly && (
        <div
          className="absolute -right-0.5 top-0 z-10 h-full w-1.5 cursor-col-resize"
          onMouseDown={startResize}
          onClick={(e) => e.stopPropagation()}
        />
      )}
    </div>
  );
}

function TableContextMenu({
  menu,
  onClose,
  onAction,
}: {
  menu: MenuState;
  onClose: () => void;
  onAction: (
    action: 'insertRowAbove' | 'insertRowBelow' | 'deleteRow' | 'insertColLeft' | 'insertColRight' | 'deleteCol',
  ) => void;
}): JSX.Element {
  const { t } = useTranslation('table');
  useEffect(() => {
    const close = (): void => onClose();
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [onClose]);

  const Item = ({ action, label, danger }: { action: Parameters<typeof onAction>[0]; label: string; danger?: boolean }) => (
    <button
      type="button"
      className={cn(
        'block w-full rounded px-2.5 py-1 text-left text-xs hover:bg-hover',
        danger ? 'text-danger' : 'text-text-secondary hover:text-text-primary',
      )}
      onMouseDown={(e) => {
        e.stopPropagation();
        onAction(action);
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      className="fixed z-50 w-36 rounded-lg border border-border bg-elevated p-1 shadow-pop"
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {menu.fileRow !== null && (
        <>
          <Item action="insertRowAbove" label={t('csv.ctxInsertRowAbove')} />
          <Item action="insertRowBelow" label={t('csv.ctxInsertRowBelow')} />
          <Item action="deleteRow" label={t('csv.ctxDeleteRow')} danger />
          <div className="my-1 border-t border-border" />
        </>
      )}
      <Item action="insertColLeft" label={t('csv.ctxInsertColLeft')} />
      <Item action="insertColRight" label={t('csv.ctxInsertColRight')} />
      <Item action="deleteCol" label={t('csv.ctxDeleteCol')} danger />
    </div>
  );
}

function FilterPopover({
  x,
  y,
  values,
  selected,
  onApply,
  onClose,
}: {
  x: number;
  y: number;
  values: string[];
  selected: Set<string> | null;
  onApply: (set: Set<string> | null) => void;
  onClose: () => void;
}): JSX.Element {
  const { t } = useTranslation('table');
  const [checked, setChecked] = useState<Set<string>>(() => new Set(selected ?? values));
  const capped = values.length > FILTER_VALUE_CAP;

  useEffect(() => {
    function onDown(e: MouseEvent): void {
      const el = e.target as HTMLElement;
      if (!el.closest('[data-filter-popover]')) onClose();
    }
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <div
      data-filter-popover
      className="fixed z-50 flex max-h-80 w-52 flex-col rounded-lg border border-border bg-elevated shadow-pop"
      style={{ left: Math.min(x, window.innerWidth - 220), top: Math.min(y, window.innerHeight - 320) }}
    >
      <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-xs text-text-tertiary">
        <button type="button" className="underline hover:text-text-secondary" onClick={() => setChecked(new Set(values))}>
          {t('csv.selectAll')}
        </button>
        <button type="button" className="underline hover:text-text-secondary" onClick={() => setChecked(new Set())}>
          {t('csv.clearAll')}
        </button>
        {capped && <span className="ml-auto">{t('csv.tooManyValues', { cap: FILTER_VALUE_CAP })}</span>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {values.map((v) => (
          <label key={v} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-text-secondary hover:bg-hover">
            <input
              type="checkbox"
              checked={checked.has(v)}
              onChange={(e) => {
                setChecked((prev) => {
                  const next = new Set(prev);
                  if (e.target.checked) next.add(v);
                  else next.delete(v);
                  return next;
                });
              }}
            />
            <span className="truncate">{v === '' ? t('csv.emptyValue') : v}</span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2 border-t border-border px-2.5 py-1.5">
        <Button size="sm" onClick={() => onApply(null)}>
          {t('csv.removeFilter')}
        </Button>
        <Button size="sm" variant="primary" onClick={() => onApply(checked.size === values.length ? null : checked)}>
          {t('csv.apply')}
        </Button>
      </div>
    </div>
  );
}
