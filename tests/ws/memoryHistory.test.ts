/**
 * memory.doc.write broadcast + memory.history.* 通道——经真 route() 验证。
 *
 * Task 3 承重点：memory.doc.write 落盘后广播 memory.doc.changed（不复用 fs.changed，避免波及项目 store）。
 *   顺序锁定：先 reply（memory.doc.result）再 broadcast（memory.doc.changed），与 fileHistory.restore 对齐。
 * Task 4 承重点：
 *   - memory.history.list → memory.history.list.result（snapshots 数组）
 *   - memory.history.get → memory.history.content（快照内容，不落盘）
 *   - memory.history.restore → memory.history.restored + 广播 memory.doc.changed
 *   - 越界 relPath（../../etc/passwd）→ error 事件（ensureWithinRoot 抛错被 router catch 兜住）
 *
 * mock 策略：替换所有底层 I/O，聚焦「注册表分发 + 回包/广播形态」，不碰真实磁盘。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Broadcast, Reply } from '../../electron/main/ws/server';
import type { ServerEventPayload } from '@shared/protocol';

// ensureWithinRoot 的沙箱实现需要 path 工具——用 vi.hoisted 提前拿，避免 vi.mock factory 里 require 的 ESM 不确定性
const { pathResolve, pathRelative, pathIsAbsolute } = vi.hoisted(() => {
  const path = require('node:path') as typeof import('node:path');
  return {
    pathResolve: path.resolve.bind(path),
    pathRelative: path.relative.bind(path),
    pathIsAbsolute: path.isAbsolute.bind(path),
  };
});

// ─── memory.ts 需要的 mock ──────────────────────────────────────────────────
vi.mock('../../electron/main/memory/trash', () => ({ moveToTrash: vi.fn() }));
vi.mock('../../electron/main/memory/changelog', () => ({ changelogPath: () => '/tmp/changelog.md' }));
vi.mock('../../electron/main/memory/dreamScheduler', () => ({ runOnce: vi.fn() }));
vi.mock('../../electron/main/memory/store', () => ({
  readAgentSelf: vi.fn(),
  readEpisode: vi.fn(),
  listAllEpisodesWithSuperseded: vi.fn(),
  readPredecessor: vi.fn(),
}));
vi.mock('../../electron/main/memory/applyOps', () => ({ applyOps: vi.fn() }));
vi.mock('../../electron/main/memory/projectProfile', () => ({ readProjectProfile: vi.fn() }));
vi.mock('../../electron/main/memory/projectList', () => ({ readAllProjectListEntriesForUI: vi.fn() }));
vi.mock('../../electron/main/memory/documentIo', () => ({
  writeMemoryDocument: vi.fn(async () => {}),
}));

// readMarkdownFile：write 后 read-back 用，返回最小合法内容
// ensureWithinRoot：保留真实沙箱逻辑（越界抛错），不 stub 成 pass-through，否则越界测试假过
vi.mock('../../electron/main/fs/frontmatter', () => ({
  ensureWithinRoot: (root: string, target: string): string => {
    const rootAbs = pathResolve(root);
    const abs = pathIsAbsolute(target) ? pathResolve(target) : pathResolve(rootAbs, target);
    const rel = pathRelative(rootAbs, abs);
    if (rel.startsWith('..') || pathIsAbsolute(rel)) {
      throw new Error(`path ${target} escapes memory root ${root}`);
    }
    return abs;
  },
  readMarkdownFile: vi.fn(async () => ({ content: '', data: {} })),
  stringifyFrontmatter: vi.fn((_fm: unknown, body: string) => body),
}));

vi.mock('@shared/memory/profileDoc', () => ({
  parseProfileDoc: vi.fn(() => ({ impression: '', sections: [] })),
  renderProfileDoc: vi.fn(() => ''),
}));

vi.mock('../../electron/main/memory/paths', () => ({
  memoryRoot: (_ownerId: string) => '/mock-memory/owner1',
}));

vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'owner1',
}));

// ─── memoryHistory.ts 需要的 mock ───────────────────────────────────────────
vi.mock('../../electron/main/fs/fileHistory', () => ({
  listForUser: async (_fileKey: string) => [
    { id: 's1', createdAt: 1000, kind: 'manual', hash: 'h1', size: 12 },
  ],
  restore: async (_fileKey: string, snapshotId: string) => `content-of-${snapshotId}`,
  list: async () => [],
  clear: async () => {},
  snapshotConflictPair: vi.fn(),
  retagSnapshot: vi.fn(),
} satisfies Pick<
  typeof import('../../electron/main/fs/fileHistory'),
  'listForUser' | 'restore' | 'list' | 'clear' | 'snapshotConflictPair' | 'retagSnapshot'
>));

vi.mock('../../electron/main/fs/workfileWrite', () => ({
  restoreWorkfileSnapshot: async (_abs: string, snapshotId: string) => `restored-${snapshotId}`,
  recordDiscardedContent: vi.fn(),
} satisfies Pick<
  typeof import('../../electron/main/fs/workfileWrite'),
  'restoreWorkfileSnapshot' | 'recordDiscardedContent'
>));

// ─── fileHistory.ts 需要的 mock（注册表合并后全域 mock 必须到位）──────────────
vi.mock('../../electron/main/projects/store', () => ({
  getProject: async (id: string) => ({ id, path: '/proj' }),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
} satisfies Pick<
  typeof import('../../electron/main/projects/store'),
  'getProject' | 'getSettings' | 'updateSettings'
>));
vi.mock('../../electron/main/fs/projectPath', () => ({
  ensureWithinProject: async (root: string, p: string) => `${root}/${p}`,
} satisfies Pick<typeof import('../../electron/main/fs/projectPath'), 'ensureWithinProject'>));
vi.mock('../../electron/main/fs/conflictRegistry', () => ({
  markConflictOpen: vi.fn(),
  clearConflict: vi.fn(() => []),
}));
vi.mock('../../electron/main/notifications/feeds', () => ({
  feedConflictRecoverable: vi.fn(),
}));
vi.mock('../../electron/main/ws/handlers/conflictResume', () => ({
  resumeDeferredWritesAfterResolve: vi.fn(),
}));
vi.mock('../../electron/main/i18n/effectiveLang', () => ({
  resolveEffectiveLang: vi.fn(() => 'zh'),
}));

import { route } from '../../electron/main/ws/router';

/** harness：分别收集 reply 和 broadcast，并按事件顺序记入 timeline 供顺序断言 */
function harness() {
  const replies: ServerEventPayload[] = [];
  const broadcasts: ServerEventPayload[] = [];
  const timeline: Array<{ kind: 'reply' | 'broadcast'; ev: ServerEventPayload }> = [];
  const reply: Reply = (_reqId, ev) => {
    replies.push(ev);
    timeline.push({ kind: 'reply', ev });
  };
  const broadcast: Broadcast = (ev) => {
    broadcasts.push(ev);
    timeline.push({ kind: 'broadcast', ev });
  };
  return { reply, broadcast, replies, broadcasts, timeline };
}

afterEach(() => vi.clearAllMocks());

// ─── Task 3：memory.doc.write 广播 ──────────────────────────────────────────
describe('Task 3 · memory.doc.write 落盘后广播 memory.doc.changed', () => {
  it('写档案后 reply memory.doc.result，再广播 memory.doc.changed（不广播 fs.changed）', async () => {
    const h = harness();
    await route(
      {
        type: 'memory.doc.write',
        reqId: 'r1',
        relPath: 'user/profile.md',
        doc: { impression: '测试', sections: [] },
      },
      h.reply,
      h.broadcast,
    );
    // 内容正确
    expect(h.replies[0]).toMatchObject({ type: 'memory.doc.result', relPath: 'user/profile.md' });
    expect(h.broadcasts).toEqual([{ type: 'memory.doc.changed', relPath: 'user/profile.md' }]);
    // 顺序锁定：先 reply 再 broadcast（与 fileHistory.restore 对齐）
    expect(h.timeline[0].kind).toBe('reply');
    expect(h.timeline[1].kind).toBe('broadcast');
  });
});

// ─── Task 4：memory.history.* 通道 ──────────────────────────────────────────
describe('Task 4 · memory.history.* 通道（memoryRoot 沙箱）', () => {
  it('list：回 memory.history.list.result（snapshots 数组），零广播', async () => {
    const h = harness();
    await route(
      { type: 'memory.history.list', reqId: 'r2', relPath: 'user/profile.md' },
      h.reply,
      h.broadcast,
    );
    expect(h.replies[0]).toMatchObject({
      type: 'memory.history.list.result',
      relPath: 'user/profile.md',
      snapshots: expect.arrayContaining([expect.objectContaining({ id: 's1' })]),
    });
    expect(h.broadcasts).toEqual([]);
  });

  it('get：回 memory.history.content（快照内容，不落盘），零广播', async () => {
    const h = harness();
    await route(
      {
        type: 'memory.history.get',
        reqId: 'r3',
        relPath: 'user/profile.md',
        snapshotId: 'snap42',
      },
      h.reply,
      h.broadcast,
    );
    expect(h.replies[0]).toMatchObject({
      type: 'memory.history.content',
      relPath: 'user/profile.md',
      snapshotId: 'snap42',
      content: 'content-of-snap42',
    });
    expect(h.broadcasts).toEqual([]);
  });

  it('restore：回 memory.history.restored + 广播 memory.doc.changed', async () => {
    const h = harness();
    await route(
      {
        type: 'memory.history.restore',
        reqId: 'r4',
        relPath: 'user/profile.md',
        snapshotId: 'snap99',
      },
      h.reply,
      h.broadcast,
    );
    expect(h.replies[0]).toMatchObject({
      type: 'memory.history.restored',
      relPath: 'user/profile.md',
      content: 'restored-snap99',
    });
    expect(h.broadcasts).toEqual([{ type: 'memory.doc.changed', relPath: 'user/profile.md' }]);
    // 顺序锁定：先 reply（memory.history.restored）再 broadcast（memory.doc.changed），与 doc.write 对齐
    expect(h.timeline[0].kind).toBe('reply');
    expect(h.timeline[1].kind).toBe('broadcast');
  });

  it('越界 relPath（../../etc/passwd）→ error 事件（沙箱生效，不广播）', async () => {
    const h = harness();
    await route(
      {
        type: 'memory.history.restore',
        reqId: 'r5',
        relPath: '../../etc/passwd',
        snapshotId: 'snap1',
      },
      h.reply,
      h.broadcast,
    );
    // ensureWithinRoot 抛错被 router catch 兜，回 error 事件
    expect(h.replies[0]).toMatchObject({ type: 'error' });
    // 越界不广播
    expect(h.broadcasts).toEqual([]);
  });
});
