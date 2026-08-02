/**
 * fileHistory.* —— 经真 route() 验证命令注册表分发（D2(a) 迁移域）。
 *
 * 承重点：list/get/clear 纯 reply 不广播；唯独 restore 写回后广播 fs.changed（让预览/树刷新）。
 * 用 vi.mock 替换底层 fs 依赖，聚焦「分发到 handler + 回包/广播形态」，不碰真实磁盘（核心逻辑
 * 另有 tests/fs/fileHistory.test.ts 覆盖）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Broadcast, Reply } from '../../electron/main/ws/server';
import type { ServerEventPayload } from '@shared/protocol';

vi.mock('../../electron/main/projects/store', () => ({
  getProject: async (id: string) => ({ id, path: '/proj' }),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getProject' | 'getSettings' | 'updateSettings'>);
vi.mock('../../electron/main/fs/projectPath', () => ({
  ensureWithinProject: async (root: string, p: string) => `${root}/${p}`,
}) satisfies Pick<typeof import('../../electron/main/fs/projectPath'), 'ensureWithinProject'>);
vi.mock('../../electron/main/fs/fileHistory', () => ({
  listForUser: async () => [{ id: 's1', label: 'snap', at: 0 }],
  restore: async (_abs: string, snapshotId: string) => `content-of-${snapshotId}`,
  clear: async () => {},
}));
vi.mock('../../electron/main/fs/workfileWrite', () => ({
  restoreWorkfileSnapshot: async (_abs: string, snapshotId: string) => `restored-${snapshotId}`,
}) satisfies Pick<typeof import('../../electron/main/fs/workfileWrite'), 'restoreWorkfileSnapshot'>);

import { route } from '../../electron/main/ws/router';

function harness() {
  const replies: ServerEventPayload[] = [];
  const broadcasts: ServerEventPayload[] = [];
  const reply: Reply = (_reqId, ev) => void replies.push(ev);
  const broadcast: Broadcast = (ev) => void broadcasts.push(ev);
  return { reply, broadcast, replies, broadcasts };
}
afterEach(() => vi.clearAllMocks());

describe('route(fileHistory.*) 走命令注册表', () => {
  it('list：回 fileHistory.list.result，零广播', async () => {
    const h = harness();
    await route({ type: 'fileHistory.list', reqId: 'r1', projectId: 'p', path: 'a.md' }, h.reply, h.broadcast);
    expect(h.replies[0]).toMatchObject({ type: 'fileHistory.list.result', projectId: 'p', path: 'a.md' });
    expect(h.broadcasts).toEqual([]);
  });

  it('get：回 fileHistory.content（带 snapshotId + content），零广播', async () => {
    const h = harness();
    await route({ type: 'fileHistory.get', reqId: 'r2', projectId: 'p', path: 'a.md', snapshotId: 's9' }, h.reply, h.broadcast);
    expect(h.replies[0]).toMatchObject({ type: 'fileHistory.content', snapshotId: 's9', content: 'content-of-s9' });
    expect(h.broadcasts).toEqual([]);
  });

  it('restore：回 fileHistory.restored 并广播 fs.changed（承重：唯一广播的 case）', async () => {
    const h = harness();
    await route({ type: 'fileHistory.restore', reqId: 'r3', projectId: 'p', path: 'a.md', snapshotId: 's9' }, h.reply, h.broadcast);
    expect(h.replies[0]).toMatchObject({ type: 'fileHistory.restored', content: 'restored-s9' });
    expect(h.broadcasts).toEqual([{ type: 'fs.changed', projectId: 'p' }]);
  });

  it('clear：回 ack，零广播', async () => {
    const h = harness();
    await route({ type: 'fileHistory.clear', reqId: 'r4', projectId: 'p', path: 'a.md' }, h.reply, h.broadcast);
    expect(h.replies).toEqual([{ type: 'ack' }]);
    expect(h.broadcasts).toEqual([]);
  });
});
