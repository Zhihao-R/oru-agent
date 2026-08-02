/**
 * 导出前置判据回归 —— 与保存同一条口径：**只有不可逆的编码转换值得拦下来问用户**。
 *
 * 修复前：导出按 canonical（编码 + 风格）拦。于是同一张 Excel 导出来的 CRLF 表，用户编辑保存
 * 不被问，一点导出反而弹一句「要不要转规范格式」——他无从判断，两处一严一宽。
 * 修复后：导出与保存同判 encodingSafe，风格差异放行（它无损，导出结果也照样正确）。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { create, type StoreApi, type UseBoundStore } from 'zustand';
import type { TableSelection } from '@/lib/tableSelection';

const { flush, requestCanonicalConfirm, tableStoreHolder } = vi.hoisted(() => ({
  flush: vi.fn(async () => {}),
  requestCanonicalConfirm: vi.fn(),
  tableStoreHolder: { store: null as unknown as UseBoundStore<StoreApi<Record<string, unknown>>> },
}));

vi.mock('@/stores/tableStore', () => {
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
    setFilter: noop,
    setSelection: noop,
    setTotalRows: noop,
    commitColumnWidths: noop,
    commitRowHeight: noop,
    flush,
    flushAll: async () => {},
    manualSnapshot: async () => {},
    resolveCanonical: async () => {},
    requestCanonicalConfirm,
    dismissCanonicalConfirm: noop,
    syncFromDisk: async () => {},
    restoreFromHistory: async () => {},
    relocate: noop,
    closeIfUnder: noop,
  }));
  tableStoreHolder.store = store;
  return { useTableStore: store };
});

const wsRequest = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: wsRequest,
    subscribe: () => () => {},
    onStatus: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { CsvEditor } from '@/components/table/CsvEditor';

const PATH = 'data/sales.csv';

/** 播一张最小可编辑表；encodingSafe 是本测试唯一要拨的开关。 */
function seedTable(encodingSafe: boolean, encoding: 'utf-8' | 'gbk' = 'utf-8'): void {
  tableStoreHolder.store.setState({
    tables: {
      [PATH]: {
        projectId: 'proj1',
        headers: ['地区', '销量'],
        rows: [['华东', '10']],
        loading: false,
        saving: false,
        overLimit: false,
        previewRows: null,
        totalRows: null,
        provenance: [],
        encodingSafe,
        encoding,
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
        prefs: {},
      },
    },
  });
}

const clickExport = (): void => {
  // 工具条上的导出按钮（i18n 在测试环境解析成中文，按 title 认）
  const btn = screen.getAllByRole('button').find((b) => (b.getAttribute('title') ?? '').includes('导出'));
  expect(btn, '找不到导出按钮').toBeTruthy();
  fireEvent.click(btn!);
};

beforeEach(() => {
  flush.mockClear();
  requestCanonicalConfirm.mockClear();
  wsRequest.mockClear();
});
afterEach(() => cleanup());

describe('CsvEditor 导出前置判据', () => {
  it('风格不规范但编码安全 → 直接导出，不弹转换确认', () => {
    seedTable(true); // CRLF / 多余引号这类文件在 main 侧算 encodingSafe
    render(<CsvEditor path={PATH} isActive />);
    clickExport();
    expect(requestCanonicalConfirm).not.toHaveBeenCalled();
    expect(flush).toHaveBeenCalledWith(PATH); // 先 flush 再导出，走的是放行那条路
  });

  it('编码不安全（GBK）→ 先弹转换确认，不直接导出', () => {
    seedTable(false, 'gbk');
    render(<CsvEditor path={PATH} isActive />);
    clickExport();
    expect(requestCanonicalConfirm).toHaveBeenCalledWith(PATH);
    expect(flush).not.toHaveBeenCalled();
  });
});
