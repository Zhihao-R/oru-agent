/**
 * bindMemoryDocSync（nit 12）：订阅 memory.doc.changed → 对该 relPath 重新 fetchDoc，
 * docLastUpdatedByPath 即时刷新（修「最后修订于 —」与「编辑后日期陈旧」——同一根因：
 * 广播在渲染端零消费者）。覆盖 AI 写档 / 历史恢复等全部写入路径。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@shared/protocol';

const requestMock = vi.fn();
let listener: ((ev: ServerEvent) => void) | null = null;
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: (cb: (ev: ServerEvent) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import {
  useMemoryStore,
  bindMemoryDocSync,
  __resetMemoryDocSyncForTest,
} from '@/stores/memoryStore';

beforeEach(() => {
  requestMock.mockReset();
  listener = null;
  useMemoryStore.setState({ docs: {}, docLastUpdatedByPath: {} });
});
afterEach(() => {
  __resetMemoryDocSyncForTest();
});

describe('bindMemoryDocSync · memory.doc.changed → fetchDoc 刷新（nit 12）', () => {
  it('命中事件 → 发出 memory.doc.read 且 Map 更新 lastUpdated', async () => {
    requestMock.mockResolvedValue({
      type: 'memory.doc.result',
      relPath: 'user/profile.md',
      doc: { frontmatter: {}, sections: [] },
      lastUpdated: '2026-08-01',
    });
    bindMemoryDocSync();
    expect(listener).not.toBeNull();

    listener!({ type: 'memory.doc.changed', relPath: 'user/profile.md' });
    await vi.waitFor(() => {
      expect(useMemoryStore.getState().docLastUpdatedByPath['user/profile.md']).toBe('2026-08-01');
    });
    expect(requestMock).toHaveBeenCalledWith({ type: 'memory.doc.read', relPath: 'user/profile.md' });
  });

  it('无关事件不触发 read；__reset 后解订阅', async () => {
    bindMemoryDocSync();
    listener!({ type: 'memory.doc.changed', relPath: 'other/doc.md' });
    listener!({ type: 'fs.changed' } as ServerEvent);
    await new Promise((r) => setTimeout(r, 10));
    // other/doc.md 也会 read（事件按 relPath 路由，全部档案变更都该刷）；fs.changed 不触发
    expect(requestMock).toHaveBeenCalledTimes(1);
    expect(requestMock).toHaveBeenCalledWith({ type: 'memory.doc.read', relPath: 'other/doc.md' });

    __resetMemoryDocSyncForTest();
    expect(listener).toBeNull();
    // 重新 bind 可用（guard 已清）
    bindMemoryDocSync();
    expect(listener).not.toBeNull();
  });
});
