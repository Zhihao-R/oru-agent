/**
 * trashCleaner 单测 —— 回收站清除·独立每日定时（S35·G36）
 *
 * 脱离 dream：sweep 委托 cleanupOldTrash(当前 owner, 30)，失败静默不抛。
 * cleanupOldTrash 的删除逻辑本身在 trash.test.ts 覆盖，这里只验「独立调度的委托 + 容错」。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const { cleanupOldTrash, getCurrentOwnerId } = vi.hoisted(() => ({
  cleanupOldTrash: vi.fn<(typeof import('../../electron/main/memory/trash'))['cleanupOldTrash']>(),
  getCurrentOwnerId:
    vi.fn<(typeof import('../../electron/main/identity/getCurrentOwnerId'))['getCurrentOwnerId']>(),
}));

vi.mock('../../electron/main/memory/trash', () => ({ cleanupOldTrash }));
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({ getCurrentOwnerId }));

import { __sweepForTest } from '../../electron/main/memory/trashCleaner';

beforeEach(() => {
  cleanupOldTrash.mockReset();
  getCurrentOwnerId.mockReset();
  getCurrentOwnerId.mockReturnValue('owner-x');
});

describe('trashCleaner.sweep', () => {
  it('委托 cleanupOldTrash(当前 owner, 30)', async () => {
    cleanupOldTrash.mockResolvedValue(2);
    const deleted = await __sweepForTest('launch');
    expect(getCurrentOwnerId).toHaveBeenCalled();
    expect(cleanupOldTrash).toHaveBeenCalledWith('owner-x', 30);
    expect(deleted).toBe(2);
  });

  it('cleanupOldTrash 抛错 → 静默返回 0（best-effort，不阻塞其它系统例行）', async () => {
    cleanupOldTrash.mockRejectedValue(new Error('disk error'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const deleted = await __sweepForTest('daily');
      expect(deleted).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
