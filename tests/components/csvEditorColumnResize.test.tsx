/**
 * CsvEditor 列宽拖拽持久化回归——钉住 stale closure 修复（commit 3ce59193）。
 *
 * bug：HeaderCell.startResize 的 window mouseup 监听在 mousedown 帧注册，旧写法 onResizeEnd()
 *   无参、父组件闭包读到拖前 colWidths，导致落盘的是**拖拽前**旧宽度，列宽实际从不持久化。
 * 修复：startResize 用 latestW 跟踪最新宽度、onUp 调 onResizeEnd(latestW)，父组件按传入宽度落盘。
 *
 * 本测试模拟一次「按下把手→拖动→松手」，断言 commitColumnWidths 收到的是**拖后**宽度（startW + Δ），
 * 而非拖前值。只验「被调用」不足以钉住 bug——必须验传入的宽度是拖后值。回退修复此断言应变红。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { TablePrefs } from '@shared/protocol';

// ── mock tableStore：真 zustand store（保证 useTableStore(selector) 订阅 + getState 都可用），
//    但所有 action 换成 spy。commitColumnWidths 是承重断言目标。 ──
// 选区类型从源头 import（曾在这里复制过一份，源类型改语义时影子定义不会跟着走）
import type { TableSelection } from '@/lib/tableSelection';

const { commitColumnWidths, commitRowHeight, setFilter, tableStoreHolder } = vi.hoisted(() => ({
  commitColumnWidths: vi.fn(),
  commitRowHeight: vi.fn(),
  setFilter: vi.fn(),
  // 用 holder 让 mock 工厂与测试共享同一 store 实例引用
  tableStoreHolder: { store: null as unknown as UseBoundStore<StoreApi<Record<string, unknown>>> },
}));

vi.mock('@/stores/tableStore', () => {
  // 仅实现组件真正会调到的 action；其余按需补 no-op（satisfies 由消费点的调用签名兜）。
  const noop = (): void => {};
  const store = create<Record<string, unknown>>(() => ({
    tables: {},
    open: noop,
    close: noop,
    editCell: noop,
    editHeader: noop,
    insertRow: noop,
    deleteRow: noop,
    insertCol: noop,
    deleteCol: noop,
    undo: noop,
    redo: noop,
    cycleSort: noop,
    setFilter,
    setSelection: noop,
    setTotalRows: noop,
    commitColumnWidths,
    commitRowHeight,
    flush: async () => {},
    flushAll: async () => {},
    manualSnapshot: async () => {},
    resolveCanonical: async () => {},
    requestCanonicalConfirm: noop,
    dismissCanonicalConfirm: noop,
    syncFromDisk: async () => {},
    restoreFromHistory: async () => {},
    relocate: noop,
    closeIfUnder: noop,
  }));
  tableStoreHolder.store = store;
  return { useTableStore: store };
});

// wsClient：CsvEditor 只在导出/交互时才真正 request，mount 不触碰；给最小 satisfies 面。
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: vi.fn(async () => ({})),
    subscribe: () => () => {},
    onStatus: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { CsvEditor } from '@/components/table/CsvEditor';

const PATH = 'data/sales.csv';
const COL0_WIDTH = 120;
const COL1_WIDTH = 120;

/** 播一个非超限、可编辑的最小表进 mock store 的桶。 */
function seedTable(prefs: TablePrefs = { columnWidths: [COL0_WIDTH, COL1_WIDTH] }): void {
  tableStoreHolder.store.setState({
    tables: {
      [PATH]: {
        projectId: 'proj1',
        headers: ['地区', '销量'],
        rows: [
          ['华东', '10'],
          ['华南', '20'],
        ],
        loading: false,
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
        filters: new Map<number, Set<string>>(),
        selection: null as TableSelection,
        pendingCanonicalConfirm: false,
        prefs,
      },
    },
  });
}

/** 表头列 resize 把手：cursor-col-resize 的 div（onMouseDown=startResize）。 */
function resizeHandles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.cursor-col-resize'));
}

beforeEach(() => {
  commitColumnWidths.mockReset();
  commitRowHeight.mockReset();
  setFilter.mockReset();
  seedTable();
});
afterEach(() => cleanup());

describe('CsvEditor 列宽拖拽持久化', () => {
  it('拖拽某列表头把手后 commitColumnWidths 落盘的是拖后宽度（钉住 stale closure）', () => {
    const { container } = render(<CsvEditor path={PATH} isActive />);

    const handles = resizeHandles(container);
    // 两列各一个 resize 把手（表头有 2 列）
    expect(handles.length).toBeGreaterThanOrEqual(2);

    const DELTA = 40;
    const handle = handles[0]!; // 第 0 列
    // 按下→拖动→松手：mousemove/mouseup 挂在 window，故对 window 派发
    fireEvent.mouseDown(handle, { clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 200 + DELTA });
    fireEvent.mouseUp(window);

    // 承重断言：第 0 列宽 = 拖后值（120 + 40 = 160），第 1 列不变（120）。
    // 回退修复（onResizeEnd 无参、读拖前 closure）时，这里会是 [120, 120] → 变红。
    expect(commitColumnWidths).toHaveBeenCalledTimes(1);
    const widths = commitColumnWidths.mock.calls[0]![1] as number[];
    expect(widths).toEqual([COL0_WIDTH + DELTA, COL1_WIDTH]);
  });

  it('拖到极小仍 clamp 到 ≥56（MIN_COL_WIDTH），不落盘负宽', () => {
    const { container } = render(<CsvEditor path={PATH} isActive />);
    const handle = resizeHandles(container)[0]!;

    fireEvent.mouseDown(handle, { clientX: 200 });
    fireEvent.mouseMove(window, { clientX: 200 - 999 }); // 往回拖到远小于下限
    fireEvent.mouseUp(window);

    const widths = commitColumnWidths.mock.calls[0]![1] as number[];
    expect(widths[0]).toBe(56); // clamp 下限
    expect(widths[1]).toBe(COL1_WIDTH);
  });
});
