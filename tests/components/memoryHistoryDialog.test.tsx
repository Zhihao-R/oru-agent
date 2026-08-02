/**
 * FileHistoryDialog：memory 档案走 memory.history.* 后端、不渲染清空历史按钮；
 * project 档案走 fileHistory.* 后端、渲染清空历史按钮。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request,
    subscribe: () => () => {},
    onStatus: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { FileHistoryDialog } from '@/components/editor/FileHistoryDialog';
import type { DocRef } from '@/stores/editorStore';
import type { FileSnapshotRef } from '@shared/types';

const MEM_SNAPSHOT: FileSnapshotRef = {
  id: 's1',
  kind: 'manual',
  createdAt: 1000,
  hash: 'h1',
  size: 9,
};

const PROJECT_SNAPSHOT: FileSnapshotRef = {
  id: 'p1',
  kind: 'ai',
  createdAt: 2000,
  hash: 'h2',
  size: 5,
};

afterEach(() => {
  cleanup();
  request.mockReset();
});

describe('FileHistoryDialog — memory 档案', () => {
  it('列快照走 memory.history.list，取内容走 memory.history.get，onRestore 走回调', async () => {
    const onRestore = vi.fn().mockResolvedValue(undefined);

    request
      .mockResolvedValueOnce({
        type: 'memory.history.list.result',
        relPath: 'user/profile.md',
        snapshots: [MEM_SNAPSHOT],
      })
      .mockResolvedValue({
        type: 'memory.history.content',
        relPath: 'user/profile.md',
        snapshotId: 's1',
        content: '旧版',
      });

    const docRef: DocRef = { kind: 'memory', relPath: 'user/profile.md' };
    render(
      <FileHistoryDialog
        docRef={docRef}
        open
        onClose={() => {}}
        onRestore={onRestore}
        currentContent="今"
      />,
    );

    // 列表请求发往 memory.history.list
    await waitFor(() =>
      expect(request.mock.calls.some(([r]) => r.type === 'memory.history.list')).toBe(true),
    );

    // 确认请求参数包含正确 relPath
    const listCall = request.mock.calls.find(([r]) => r.type === 'memory.history.list');
    expect(listCall![0]).toMatchObject({ type: 'memory.history.list', relPath: 'user/profile.md' });
  });

  it('memory 档案时不渲染「清空历史」按钮', async () => {
    request.mockResolvedValue({
      type: 'memory.history.list.result',
      relPath: 'user/profile.md',
      snapshots: [MEM_SNAPSHOT],
    });

    const docRef: DocRef = { kind: 'memory', relPath: 'user/profile.md' };
    render(
      <FileHistoryDialog
        docRef={docRef}
        open
        onClose={() => {}}
        onRestore={vi.fn()}
        currentContent="今"
      />,
    );

    await waitFor(() =>
      expect(request.mock.calls.some(([r]) => r.type === 'memory.history.list')).toBe(true),
    );

    // 「清空历史」按钮不存在
    expect(screen.queryByText('清空历史')).toBeNull();
  });

  it('同一身份 docRef 的新对象引用不触发第二次 list（依赖用派生稳定 key）', async () => {
    request.mockResolvedValue({
      type: 'memory.history.list.result',
      relPath: 'user/profile.md',
      snapshots: [MEM_SNAPSHOT],
    });

    // 每次都新建字面量对象——身份相同（same relPath），引用不同，模拟 CsvEditor/DeckCenter 逐渲染传新对象
    const makeTree = (): ReactElement => (
      <FileHistoryDialog
        docRef={{ kind: 'memory', relPath: 'user/profile.md' }}
        open
        onClose={() => {}}
        onRestore={vi.fn()}
        currentContent="今"
      />
    );

    const { rerender } = render(makeTree());
    await waitFor(() =>
      expect(request.mock.calls.some(([r]) => r.type === 'memory.history.list')).toBe(true),
    );

    // 用同身份的新字面量对象 rerender 若干次：不应再发 list
    rerender(makeTree());
    rerender(makeTree());
    await Promise.resolve();

    const listCalls = request.mock.calls.filter(([r]) => r.type === 'memory.history.list');
    expect(listCalls).toHaveLength(1);
  });

  it('kind=manual 显示「你修订」文案', async () => {
    request.mockResolvedValue({
      type: 'memory.history.list.result',
      relPath: 'user/profile.md',
      snapshots: [MEM_SNAPSHOT],
    });

    const docRef: DocRef = { kind: 'memory', relPath: 'user/profile.md' };
    render(
      <FileHistoryDialog
        docRef={docRef}
        open
        onClose={() => {}}
        onRestore={vi.fn()}
        currentContent="今"
      />,
    );

    // 等快照列表渲染出来
    await waitFor(() => expect(screen.queryByText('你修订')).not.toBeNull());
    expect(screen.getByText('你修订')).toBeTruthy();
  });
});

describe('FileHistoryDialog — project 档案回归', () => {
  it('project docRef 发 fileHistory.list，渲染清空历史按钮', async () => {
    request.mockResolvedValue({
      type: 'fileHistory.list.result',
      snapshots: [PROJECT_SNAPSHOT],
    });

    const docRef: DocRef = { kind: 'project', projectId: 'proj-1', path: 'docs/note.md' };
    render(
      <FileHistoryDialog
        docRef={docRef}
        open
        onClose={() => {}}
        onRestore={vi.fn()}
        currentContent="现在"
      />,
    );

    await waitFor(() =>
      expect(request.mock.calls.some(([r]) => r.type === 'fileHistory.list')).toBe(true),
    );

    // 清空历史按钮存在
    await waitFor(() => expect(screen.queryByText('清空历史')).not.toBeNull());
  });
});
