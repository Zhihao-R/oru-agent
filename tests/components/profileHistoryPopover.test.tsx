/**
 * ProfileHistoryPopover 承重测试：
 * 打开即走 memory.history.list 列快照、点「恢复」经 onRestore 回调、完成后自关。
 *
 * @vitest-environment jsdom
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';
import type { FileSnapshotRef } from '@shared/types';

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

import { ProfileHistoryPopover } from '@/components/memory/ProfileHistoryPopover';

const MANUAL: FileSnapshotRef = { id: 's1', kind: 'manual', createdAt: 1000, hash: 'h1', size: 9 };
const AI: FileSnapshotRef = { id: 's2', kind: 'ai', createdAt: 2000, hash: 'h2', size: 5 };

afterEach(() => {
  cleanup();
  request.mockReset();
});

it('打开列快照走 memory.history.list，manual→「你修订」/ai→「Oru 补充」', async () => {
  request.mockResolvedValue({
    type: 'memory.history.list.result',
    relPath: 'user/profile.md',
    snapshots: [MANUAL, AI],
  });

  render(<ProfileHistoryPopover relPath="user/profile.md" onRestore={vi.fn()} onClose={() => {}} />);

  await waitFor(() =>
    expect(request.mock.calls.some(([r]) => r.type === 'memory.history.list')).toBe(true),
  );
  const listCall = request.mock.calls.find(([r]) => r.type === 'memory.history.list');
  expect(listCall![0]).toMatchObject({ type: 'memory.history.list', relPath: 'user/profile.md' });

  expect(await screen.findByText('你修订了档案')).toBeTruthy();
  expect(screen.getByText('Oru 补充')).toBeTruthy();
});

it('点「恢复」经 onRestore(id) 回调、完成后 onClose', async () => {
  request.mockResolvedValue({
    type: 'memory.history.list.result',
    relPath: 'user/profile.md',
    snapshots: [AI],
  });
  const onRestore = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();

  render(<ProfileHistoryPopover relPath="user/profile.md" onRestore={onRestore} onClose={onClose} />);

  const restoreBtn = await screen.findByRole('button', { name: '恢复' });
  await act(async () => {
    fireEvent.click(restoreBtn);
    await new Promise((r) => setTimeout(r, 10));
  });

  expect(onRestore).toHaveBeenCalledWith('s2');
  await waitFor(() => expect(onClose).toHaveBeenCalled());
});

it('无快照显示空态提示', async () => {
  request.mockResolvedValue({
    type: 'memory.history.list.result',
    relPath: 'user/profile.md',
    snapshots: [],
  });

  render(<ProfileHistoryPopover relPath="user/profile.md" onRestore={vi.fn()} onClose={() => {}} />);

  expect(await screen.findByText('还没有历史版本。改动一会儿后会自动保存。')).toBeTruthy();
});
