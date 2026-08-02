/**
 * Loop 跨重启 boot 对账（T3 修订后）：残留快照 → 纯陈列 interrupted 终态卡（done:true、无询问），
 * 卡落盘后删快照。ORU_DIR 走 vi.hoisted 隔离（vitest 静态 import 提升陷阱）。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = vi.hoisted(() => {
  const dir = `${process.env.TMPDIR ?? '/tmp'}/oru-test-loopboot-${process.pid}`;
  process.env.ORU_DIR = dir;
  return dir;
});

vi.mock('../../electron/main/conversations/store', () => ({
  appendMessage: vi.fn(async () => {}),
  readHistory: vi.fn(async () => []),
}));
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: async () => ({ loopMaxRounds: 5 }),
}));

import { reconcileLoopRunsOnBoot } from '../../electron/main/loop/bootReconcile';
import { buildRunState, saveLoopRunState, listLoopRunStates } from '../../electron/main/loop/persist';
import { appendMessage, readHistory } from '../../electron/main/conversations/store';
import type { ChatMessage } from '@shared/types';

beforeAll(async () => {
  await fs.mkdir(join(ORU_DIR), { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('boot 对账 · 中断卡纯陈列', () => {
  it('残留快照 → 落 done:true 的 interrupted 卡（无待决语义）→ 快照即删', async () => {
    await saveLoopRunState(
      buildRunState({
        loopId: 'lp1',
        conversationId: 'c1',
        agentId: 'ag1',
        goal: '打磨报告',
        round: 3,
        checklist: [{ id: 'c1', statement: '有第三节', status: 'satisfied' }],
        now: 111,
      }),
    );

    const events: Array<{ type: string }> = [];
    const done = await reconcileLoopRunsOnBoot((ev) => events.push(ev));
    expect(done).toEqual(['lp1']);

    // 卡是纯陈列终态：done:true、phase interrupted、进度数据齐全
    const persisted = vi.mocked(appendMessage).mock.calls.map((c) => c[2] as ChatMessage);
    const card = persisted.find((m) => m.kind === 'loop-checklist');
    expect(card).toMatchObject({ done: true });
    expect(card?.loopCard).toMatchObject({ phase: 'interrupted', round: 3, goal: '打磨报告' });
    expect(events.some((e) => e.type === 'chat.loopCard')).toBe(true);

    // 快照使命完成（数据已入对话历史）→ 已删，下次 boot 不重复落卡
    expect(await listLoopRunStates()).toEqual([]);
  });

  it('幂等（崩溃窗口）：同 id 卡已在历史（如终态卡落盘后、删快照前崩溃）→ 只删快照、不再追加', async () => {
    vi.clearAllMocks(); // 隔离上一用例的 appendMessage 调用记录
    await saveLoopRunState(
      buildRunState({
        loopId: 'lp2',
        conversationId: 'c2',
        agentId: 'ag1',
        goal: '已收敛的活',
        round: 2,
        checklist: [],
        now: 222,
      }),
    );
    // 历史里已有同 id 终态卡（正常收敛 done 卡落盘后、finally 删快照前进程崩溃的残局）
    vi.mocked(readHistory).mockResolvedValueOnce([
      { id: 'loopcard_lp2', conversationId: 'c2', role: 'assistant', text: '', toolCalls: [], createdAt: 0, done: true, kind: 'loop-checklist' } as ChatMessage,
    ]);

    const events: Array<{ type: string }> = [];
    const done = await reconcileLoopRunsOnBoot((ev) => events.push(ev));
    expect(done).toEqual(['lp2']);
    expect(appendMessage).not.toHaveBeenCalled(); // 不追加第二张同 id 矛盾卡
    expect(events).toEqual([]); // 也不广播
    expect(await listLoopRunStates()).toEqual([]); // 快照仍被清
  });
});
