/**
 * deck 生成同 deck 去重 + deckTaskState（资源级：同 index.html 并发写是真冲突）：
 * 同一 artifactId 已有生成任务在跑时，generateDeckForArtifact 不再派第二个，以 'busy' + 可读原因拒绝。
 * 去串行后无「排队」——deckTaskState 从 activeTasks（含启动段）查，只返回 running | null。
 * 测试用 __injectActiveTaskForTest 注入「已有 deck 生成在跑」来观测判据与 busy 返回值。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ArtifactRecord } from '@shared/types';

// 派工要拿 active agent——给个假 agent，避免读真实 ~/.oru
vi.mock('../../electron/main/agent/store/agents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/agent/store/agents')>();
  return {
    ...actual,
    listAgents: vi.fn(async () => ({
      agents: [],
      activeId: 'agent_test',
    })) satisfies typeof actual.listAgents,
  };
});
// 任务终态播报会打真实 store——掐掉，其余符号保留真实实现
vi.mock('../../electron/main/tasks/taskAnnouncer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/taskAnnouncer')>();
  return {
    ...actual,
    notifyTaskTerminal: vi.fn(() => {}) satisfies typeof actual.notifyTaskTerminal,
  };
});

import { generateDeckForArtifact } from '../../electron/main/deck/dispatchSubagent';
import {
  deckTaskState,
  __injectActiveTaskForTest,
  __resetActiveTasksForTest,
} from '../../electron/main/tasks/subagentRunner';
import { __setRunFnForTest } from '../../electron/main/tasks/queue';

function makeDeck(id: string): ArtifactRecord {
  return {
    id,
    projectId: 'prj_dedup',
    name: id,
    path: `/tmp/${id}`,
    createdAt: 0,
    updatedAt: 0,
  } satisfies ArtifactRecord;
}

/** 可控 runFn：起跑即记录在案，卡在闸门里直到 release——只防真打 Claude、记录派工，不进 activeTasks */
function gatedRunFn() {
  const started: string[] = [];
  const gates: Array<() => void> = [];
  const restore = __setRunFnForTest(async (item) => {
    started.push(item.proposal.id);
    await new Promise<void>((r) => gates.push(r));
  });
  return { started, releaseAll: () => gates.splice(0).forEach((r) => r()), restore };
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const broadcast = (): void => {};

beforeEach(() => {
  __resetActiveTasksForTest();
});

describe('deck 生成同 deck 去重（资源级）', () => {
  it('同 deck 已有生成在跑 → busy 拒绝、不重复派工', async () => {
    const deck = makeDeck('dck_run');
    const run = gatedRunFn();
    try {
      // 模拟「同 deck 已有生成任务在跑」（含启动段）——deck 去重判据来自 activeTasks
      __injectActiveTaskForTest('task_deck_run', 'conv_1', Date.now(), 'dck_run');
      expect(deckTaskState('dck_run')).toBe('running');

      const r2 = await generateDeckForArtifact({ deck, conversationId: 'conv_1', broadcast });
      expect(r2).toMatchObject({ ok: false, reason: 'busy' });
      if (!r2.ok) expect(r2.message).toContain('生成中');

      run.releaseAll();
      await tick();
      expect(run.started).toHaveLength(0); // 没有派第二个
    } finally {
      run.restore();
    }
  });

  it('不同 deck 互不影响：A 在跑时 B 照常派（去重判据是 artifactId 不是 project）', async () => {
    const a = makeDeck('dck_a');
    const b = makeDeck('dck_b');
    const run = gatedRunFn();
    try {
      __injectActiveTaskForTest('task_dck_a', 'c', Date.now(), 'dck_a');
      expect(deckTaskState('dck_a')).toBe('running');
      expect(deckTaskState('dck_b')).toBeNull();

      const r2 = await generateDeckForArtifact({ deck: b, conversationId: 'c', broadcast });
      expect(r2.ok).toBe(true); // 不同 deck 照常派

      run.releaseAll();
      await tick();
      expect(run.started).toHaveLength(1); // B 恰好派了一个
    } finally {
      run.restore();
    }
  });
});
