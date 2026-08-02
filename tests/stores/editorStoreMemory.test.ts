// @vitest-environment jsdom

/**
 * editorStore memory 后端测试（Task 3）。
 * 覆盖：readDisk memory 分支、writeDisk memory 分支（发 writeLive + baseline + mergeOnStale）、
 *       discarded 不丢用户本地内容（base 重定 Oru 版供下轮合并）、restoreFromHistory memory 分支。
 *
 * mock 注意：openRef 触发 readLive（读盘），flush/setContent+autosave 触发 writeLive（写盘）。
 * 两次调用按 req.type 分别返回，不让 openRef 的 readLive 也被 discarded 污染。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    onStatus: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useEditorStore, refKey } from '@/stores/editorStore';
import type { MemoryDocLiveEvent, MemoryHistoryRestoredEvent } from '@shared/protocol';

const S = () => useEditorStore.getState();

const REL_PATH = 'user/profile.md';
const memRef = { kind: 'memory' as const, relPath: REL_PATH };
const KEY = refKey(memRef); // 'mem:user/profile.md'

/** 按 req.type 分别 mock：readLive 返回初始内容，writeLive 返回指定结果 */
function setupMemoryWs(opts: { readContent?: string; writeResult: MemoryDocLiveEvent }): void {
  requestMock.mockImplementation((req: { type: string }) => {
    if (req.type === 'memory.doc.readLive') {
      const ev: MemoryDocLiveEvent = {
        type: 'memory.doc.live',
        relPath: REL_PATH,
        content: opts.readContent ?? 'initial',
        status: 'written',
      };
      return Promise.resolve(ev);
    }
    if (req.type === 'memory.doc.writeLive') {
      return Promise.resolve(opts.writeResult);
    }
    if (req.type === 'memory.history.restore') {
      const ev: MemoryHistoryRestoredEvent = {
        type: 'memory.history.restored',
        relPath: REL_PATH,
        content: 'restored-content',
      };
      return Promise.resolve(ev);
    }
    // 其他请求不应触发（如 fs.history.sample）
    return Promise.reject(new Error(`memory 测试不预期 req.type=${req.type}`));
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  requestMock.mockReset();
  useEditorStore.setState({ files: {} });
});

afterEach(() => {
  for (const p of Object.keys(S().files)) S().close(p);
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('Test 1：memory 桶 flush 发 writeLive（带 baseline+mergeOnStale），不发 fs.history.sample', () => {
  it('flush 发 memory.doc.writeLive 含 baseline + mergeOnStale，不发 fs.history.sample', async () => {
    const writeResult: MemoryDocLiveEvent = {
      type: 'memory.doc.live',
      relPath: REL_PATH,
      content: 'v2',
      status: 'written',
    };
    setupMemoryWs({ readContent: 'v1', writeResult });

    await S().openRef(memRef);
    expect(S().files[KEY]?.content).toBe('v1'); // openRef 读到 readLive 返回的内容

    S().setContent(KEY, 'v2');
    await S().flush(KEY);

    // 断言：发了 writeLive，带 mergeOnStale
    const writeLiveCalls = requestMock.mock.calls
      .map(([r]) => r as { type: string; mergeOnStale?: boolean; baseline?: string })
      .filter((r) => r.type === 'memory.doc.writeLive');
    expect(writeLiveCalls.length).toBeGreaterThan(0);
    expect(writeLiveCalls[0].mergeOnStale).toBe(true);
    expect(writeLiveCalls[0].baseline).toBeDefined(); // 发了 baseline

    // 断言：没有发 fs.history.sample（memory 去噪 = 不采样）
    const sampleCalls = requestMock.mock.calls
      .map(([r]) => r as { type: string })
      .filter((r) => r.type === 'fs.history.sample');
    expect(sampleCalls.length).toBe(0);
  });
});

describe('Test 2：discarded 不丢用户本地、base 重定 Oru 版供下轮合并', () => {
  it('discarded 时用户 content 保留，lastSyncedContent 更新为 Oru 磁盘版', async () => {
    const discardedResult: MemoryDocLiveEvent = {
      type: 'memory.doc.live',
      relPath: REL_PATH,
      content: 'Oru版',
      status: 'discarded',
    };
    setupMemoryWs({ readContent: '初始内容', writeResult: discardedResult });

    await S().openRef(memRef);
    expect(S().files[KEY]?.content).toBe('初始内容');

    S().setContent(KEY, '用户版');

    // flush 触发 writeLive，后端返回 discarded
    await S().flush(KEY);

    const st = S().files[KEY];
    // 用户本地内容不丢
    expect(st?.content).toBe('用户版');
    // base 重定到 Oru 版（下轮 mergeOnStale 再合）
    expect(st?.lastSyncedContent).toBe('Oru版');

    // 锁死「discarded 分支真的重排了 autosave」——这是用户编辑最终落地的唯一出口。
    // 若有人误删 discarded 分支里的 scheduleAutosave，这条会红（本地字将永久停在磁盘外）。
    // 推进 autosave 去抖计时（800ms）后，第二次 writeLive 应带新 base=Oru版 的 baseline 发出。
    const writeCallsBefore = requestMock.mock.calls.filter(
      ([r]) => (r as { type: string }).type === 'memory.doc.writeLive',
    ).length;
    await vi.advanceTimersByTimeAsync(800);

    const rewriteCalls = requestMock.mock.calls
      .map(([r]) => r as { type: string; baseline?: string })
      .filter((r) => r.type === 'memory.doc.writeLive');
    expect(rewriteCalls.length).toBe(writeCallsBefore + 1); // 重排真的又写了一次
    expect(rewriteCalls[rewriteCalls.length - 1].baseline).toBe('Oru版'); // 以 Oru 版为新 base 三方合并
  });
});

describe('Test 3：restoreFromHistory memory 走 memory.history.restore', () => {
  it('restoreFromHistory 发 memory.history.restore，content+lastSynced 被 patch 进桶', async () => {
    const writeResult: MemoryDocLiveEvent = {
      type: 'memory.doc.live',
      relPath: REL_PATH,
      content: 'initial',
      status: 'written',
    };
    setupMemoryWs({ readContent: 'initial', writeResult });

    await S().openRef(memRef);
    expect(S().files[KEY]?.content).toBe('initial');

    await S().restoreFromHistory(KEY, 'snap-001');

    // 发了 memory.history.restore
    const restoreCalls = requestMock.mock.calls
      .map(([r]) => r as { type: string; relPath?: string; snapshotId?: string })
      .filter((r) => r.type === 'memory.history.restore');
    expect(restoreCalls.length).toBe(1);
    expect(restoreCalls[0].relPath).toBe(REL_PATH);
    expect(restoreCalls[0].snapshotId).toBe('snap-001');

    // content 和 lastSyncedContent 都更新为恢复内容
    const st = S().files[KEY];
    expect(st?.content).toBe('restored-content');
    expect(st?.lastSyncedContent).toBe('restored-content');
  });
});
