/**
 * XlsxPreview 组件合约 —— xlsx 只读预览与「原地转可编辑」。
 *
 * 钉住的链路：装载走 table.previewXlsx 请求-应答；双击格子弹确认；确认后发 table.importXlsx；
 * 无冲突（written/identical）立即 replaceTab 同位置换成 table 标签；conflict 则不动、
 * 等 table.importWritten 广播回来完成切换；取消（无广播）预览原样。
 *
 * wsClient 与 tableStore mock；workspaceStore 用真身（replaceTab 行为即被测对象）。
 * react-virtual mock 成全量渲染——虚拟化本身不是本测试对象。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const { requestMock, subscribeHub, tableOpenSpy } = vi.hoisted(() => {
  const handlers = new Set<(ev: unknown) => void>();
  return {
    requestMock: vi.fn(),
    subscribeHub: {
      subscribe: (h: (ev: unknown) => void): (() => void) => {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      emit: (ev: unknown): void => {
        handlers.forEach((h) => h(ev));
      },
    },
    tableOpenSpy: vi.fn(async () => {}),
  };
});

vi.mock('@/lib/ws', () => ({
  wsClient: { request: requestMock, subscribe: subscribeHub.subscribe },
}));

vi.mock('@/stores/tableStore', () => ({
  useTableStore: Object.assign(() => ({}), { getState: () => ({ open: tableOpenSpy }) }),
}));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () => Array.from({ length: count }, (_, i) => ({ key: i, index: i, start: i * 28 })),
  }),
}));

import { XlsxPreview } from '@/components/table/XlsxPreview';
import { makeTab, useWorkspaceStore } from '@/stores/workspaceStore';

const SHEETS = [{ name: '明细', csv: 'a,b\n1,2\n', totalRows: 1, overLimit: false }];

function mockRequests(importResult?: unknown): void {
  requestMock.mockImplementation(async (req: { type: string }) => {
    if (req.type === 'table.previewXlsx') {
      return { type: 'table.xlsxPreview', projectId: 'p1', path: 'book.xlsx', sheets: SHEETS };
    }
    if (req.type === 'table.importXlsx') return importResult;
    throw new Error(`unexpected request ${req.type}`);
  });
}

const WRITTEN = {
  type: 'table.importResult',
  projectId: 'p1',
  xlsxPath: 'book.xlsx',
  sheets: [{ name: '明细', targetPath: 'book.csv', status: 'written' }],
};

function openXlsxTab(): void {
  useWorkspaceStore.getState().openTab(makeTab({ kind: 'xlsx', projectId: 'p1', ref: 'book.xlsx', title: 'book.xlsx' }));
}

beforeEach(() => {
  useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
  requestMock.mockReset();
  tableOpenSpy.mockClear();
});

afterEach(() => cleanup());

describe('XlsxPreview', () => {
  it('装载：预览说明条 + 表头/数据渲染，零转编辑动作', async () => {
    mockRequests();
    openXlsxTab();
    render(<XlsxPreview path="book.xlsx" projectId="p1" />);

    expect(await screen.findByText('只读预览——原件未动，未生成任何文件')).toBeTruthy();
    expect(await screen.findByText('a')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock.mock.calls[0]![0]).toMatchObject({ type: 'table.previewXlsx', path: 'book.xlsx' });
  });

  it('按钮转编辑：发 table.importXlsx，written → 原地换成 table 标签（同 index）', async () => {
    mockRequests(WRITTEN);
    const ws = useWorkspaceStore.getState();
    ws.openTab(makeTab({ kind: 'image', projectId: 'p1', ref: 'prev.png', title: 'prev.png' }));
    openXlsxTab();
    render(<XlsxPreview path="book.xlsx" projectId="p1" />);

    fireEvent.click(await screen.findByText('转为可编辑 CSV'));
    await waitFor(() => {
      const tabs = useWorkspaceStore.getState().openTabs;
      expect(tabs.map((t) => t.id)).toEqual(['image:prev.png', 'table:book.csv']);
    });
    expect(useWorkspaceStore.getState().activeTabId).toBe('table:book.csv');
    expect(tableOpenSpy).toHaveBeenCalledWith('p1', 'book.csv');
  });

  it('双击格子 → 弹确认；确认后走同一转换链路', async () => {
    mockRequests(WRITTEN);
    openXlsxTab();
    render(<XlsxPreview path="book.xlsx" projectId="p1" />);

    fireEvent.doubleClick(await screen.findByText('2'));
    expect(await screen.findByText('生成可编辑的 CSV？')).toBeTruthy();
    fireEvent.click(screen.getByText('生成并编辑'));

    await waitFor(() => expect(useWorkspaceStore.getState().openTabs[0]!.id).toBe('table:book.csv'));
    expect(requestMock.mock.calls.some((c) => (c[0] as { type: string }).type === 'table.importXlsx')).toBe(true);
  });

  it('conflict → 预览不动；importWritten 广播回来才切换（savedAs 路径）', async () => {
    mockRequests({
      type: 'table.importResult',
      projectId: 'p1',
      xlsxPath: 'book.xlsx',
      sheets: [{ name: '明细', targetPath: 'book.csv', status: 'conflict' }],
    });
    openXlsxTab();
    render(<XlsxPreview path="book.xlsx" projectId="p1" />);

    fireEvent.click(await screen.findByText('转为可编辑 CSV'));
    await waitFor(() =>
      expect(requestMock.mock.calls.some((c) => (c[0] as { type: string }).type === 'table.importXlsx')).toBe(true),
    );
    // 冲突挂起：标签仍是 xlsx 预览（用户取消 = 什么都不发生）
    expect(useWorkspaceStore.getState().openTabs[0]!.id).toBe('xlsx:book.xlsx');

    subscribeHub.emit({ type: 'table.importWritten', projectId: 'p1', xlsxPath: 'book.xlsx', targetPath: 'book-2.csv' });
    await waitFor(() => expect(useWorkspaceStore.getState().openTabs[0]!.id).toBe('table:book-2.csv'));
    expect(tableOpenSpy).toHaveBeenCalledWith('p1', 'book-2.csv');
  });

  it('别的 xlsx 的 importWritten 不误切本预览', async () => {
    mockRequests();
    openXlsxTab();
    render(<XlsxPreview path="book.xlsx" projectId="p1" />);
    await screen.findByText('a');

    subscribeHub.emit({ type: 'table.importWritten', projectId: 'p1', xlsxPath: 'other.xlsx', targetPath: 'other.csv' });
    expect(useWorkspaceStore.getState().openTabs[0]!.id).toBe('xlsx:book.xlsx');
  });

  it('多 sheet：chip 切换显示另一 sheet 内容', async () => {
    requestMock.mockImplementation(async () => ({
      type: 'table.xlsxPreview',
      projectId: 'p1',
      path: 'book.xlsx',
      sheets: [
        { name: '华东', csv: 'h1\nhd-v\n', totalRows: 1, overLimit: false },
        { name: '华北', csv: 'h2\nhb-v\n', totalRows: 1, overLimit: false },
      ],
    }));
    openXlsxTab();
    render(<XlsxPreview path="book.xlsx" projectId="p1" />);

    expect(await screen.findByText('hd-v')).toBeTruthy();
    fireEvent.click(screen.getByText('华北'));
    expect(await screen.findByText('hb-v')).toBeTruthy();
  });

  it('多 sheet 转编辑：打开的是当前正在看的 sheet 对应的 CSV', async () => {
    requestMock.mockImplementation(async (req: { type: string }) => {
      if (req.type === 'table.previewXlsx') {
        return {
          type: 'table.xlsxPreview',
          projectId: 'p1',
          path: 'book.xlsx',
          sheets: [
            { name: '华东', csv: 'h1\nhd-v\n', totalRows: 1, overLimit: false },
            { name: '华北', csv: 'h2\nhb-v\n', totalRows: 1, overLimit: false },
          ],
        };
      }
      if (req.type === 'table.importXlsx') {
        return {
          type: 'table.importResult',
          projectId: 'p1',
          xlsxPath: 'book.xlsx',
          sheets: [
            { name: '华东', targetPath: 'book-华东.csv', status: 'written' },
            { name: '华北', targetPath: 'book-华北.csv', status: 'written' },
          ],
        };
      }
      throw new Error(`unexpected request ${req.type}`);
    });
    openXlsxTab();
    render(<XlsxPreview path="book.xlsx" projectId="p1" />);

    fireEvent.click(await screen.findByText('华北')); // 切到第二个 sheet 再转
    fireEvent.click(screen.getByText('转为可编辑 CSV'));
    await waitFor(() => expect(useWorkspaceStore.getState().openTabs[0]!.id).toBe('table:book-华北.csv'));
    expect(tableOpenSpy).toHaveBeenCalledWith('p1', 'book-华北.csv');
  });

  it('超限 sheet：附截断注记', async () => {
    requestMock.mockImplementation(async () => ({
      type: 'table.xlsxPreview',
      projectId: 'p1',
      path: 'book.xlsx',
      sheets: [{ name: '明细', csv: 'a\n1\n', totalRows: 123456, overLimit: true }],
    }));
    openXlsxTab();
    render(<XlsxPreview path="book.xlsx" projectId="p1" />);

    expect(await screen.findByText(/只读预览前 1,000 行/)).toBeTruthy();
  });

  it('预览失败（sheets=null）：错误态文案', async () => {
    requestMock.mockImplementation(async () => ({
      type: 'table.xlsxPreview',
      projectId: 'p1',
      path: 'book.xlsx',
      sheets: null,
      message: '无法读取该文件：可能已加密或损坏',
    }));
    openXlsxTab();
    render(<XlsxPreview path="book.xlsx" projectId="p1" />);

    expect(await screen.findByText(/无法读取该文件/)).toBeTruthy();
  });
});
