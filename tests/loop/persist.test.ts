/**
 * Loop 运行态跨重启持久化。走 process.env.ORU_DIR 重定向 tmpdir + 动态 import
 * （避免 paths.ts load 时锁死 ORU_DIR，见 project_vitest_oru_dir_isolation_trap）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChecklistItem, LoopRunState } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-loop-persist-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

type Persist = typeof import('../../electron/main/loop/persist');
let persist: Persist;

function item(id: string, over: Partial<ChecklistItem> = {}): ChecklistItem {
  return { id, statement: `项 ${id}`, status: 'pending', ...over };
}

beforeAll(async () => {
  persist = await import('../../electron/main/loop/persist');
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('buildRunState（组装快照）', () => {
  it('带上版本号与最小字段集', () => {
    const state = persist.buildRunState({
      loopId: 'l1', conversationId: 'c', agentId: 'ag', goal: 'g', round: 2,
      checklist: [item('a', { status: 'satisfied' }), item('b')], now: 111,
    });
    expect(state.version).toBe(persist.LOOP_SNAPSHOT_VERSION);
    expect(state.round).toBe(2);
    expect(state.checklist.map((i) => i.id)).toEqual(['a', 'b']);
  });
});

describe('save / list / delete（fs 往返）', () => {
  it('落盘 → 列出 → 删除', async () => {
    const state: LoopRunState = persist.buildRunState({
      loopId: 'loop-x', conversationId: 'c', agentId: 'ag', goal: '打磨报告', round: 3,
      checklist: [item('a')], now: 222,
    });
    await persist.saveLoopRunState(state);
    let all = await persist.listLoopRunStates();
    expect(all.find((s) => s.loopId === 'loop-x')?.round).toBe(3);
    expect(all.find((s) => s.loopId === 'loop-x')?.goal).toBe('打磨报告');
    await persist.deleteLoopRunState('loop-x');
    all = await persist.listLoopRunStates();
    expect(all.find((s) => s.loopId === 'loop-x')).toBeUndefined();
  });

  it('删不存在的快照 → 静默不抛', async () => {
    await expect(persist.deleteLoopRunState('never')).resolves.toBeUndefined();
  });

  it('版本不符 / 损坏的快照 → 列出时弃（不崩）', async () => {
    const dir = join(ORU_DIR, 'users', 'local-user', 'loop-runs');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(join(dir, 'future.json'), JSON.stringify({ version: 999, loopId: 'future' }));
    await fs.writeFile(join(dir, 'garbage.json'), '{ not json');
    const all = await persist.listLoopRunStates();
    expect(all.find((s) => s.loopId === 'future')).toBeUndefined();
  });
});
