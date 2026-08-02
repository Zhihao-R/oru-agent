/**
 * deck 生成同 deck 去重 + deckTaskState（走查二批该修 4）：
 * 同一 artifactId 已有生成任务在跑 / 在排时，generateDeckForArtifact 不再派第二个
 * （现状双击会排两个背靠背），并以 'busy' + 可读原因拒绝，让 UI 能如实上屏。
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
  getQueueDepth,
  __setRunFnForTest,
  __resetQueuesForTest,
} from '../../electron/main/tasks/queue';

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

/** 可控 runFn：起跑即记录在案，卡在闸门里直到 release */
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
  __resetQueuesForTest();
});

describe('deck 生成同 deck 去重（该修 4）', () => {
  it('生成任务在跑时再次 generate → busy 拒绝、不重复派工', async () => {
    const deck = makeDeck('dck_run');
    const run = gatedRunFn();
    try {
      const r1 = await generateDeckForArtifact({ deck, conversationId: 'conv_1', broadcast });
      expect(r1.ok).toBe(true);
      expect(deckTaskState(deck.id)).toBe('running');

      const r2 = await generateDeckForArtifact({ deck, conversationId: 'conv_1', broadcast });
      expect(r2).toMatchObject({ ok: false, reason: 'busy' });
      if (!r2.ok) expect(r2.message).toContain('生成中');

      run.releaseAll();
      await tick();
      expect(run.started).toHaveLength(1); // 全程恰好派了一个
    } finally {
      run.restore();
    }
  });

  it('生成任务在排（同项目有别的任务在跑）→ 显示排队、再点仍 busy', async () => {
    const deck = makeDeck('dck_queue');
    const blocker = makeDeck('dck_blocker');
    const run = gatedRunFn();
    try {
      // blocker 占住同 projectKey 的 running 位
      const r0 = await generateDeckForArtifact({ deck: blocker, conversationId: 'c', broadcast });
      expect(r0.ok).toBe(true);

      const r1 = await generateDeckForArtifact({ deck, conversationId: 'c', broadcast });
      expect(r1.ok).toBe(true);
      expect(deckTaskState(deck.id)).toBe('queued');
      expect(getQueueDepth()['prj_dedup']?.pendingCount).toBe(1);

      const r2 = await generateDeckForArtifact({ deck, conversationId: 'c', broadcast });
      expect(r2).toMatchObject({ ok: false, reason: 'busy' });
      if (!r2.ok) expect(r2.message).toContain('排队');
      expect(getQueueDepth()['prj_dedup']?.pendingCount).toBe(1); // 队列没堆第二份

      run.releaseAll();
      await tick();
      run.releaseAll();
      await tick();
      expect(run.started).toHaveLength(2); // blocker + deck 各一次
    } finally {
      run.restore();
    }
  });

  it('不同 deck 互不影响：A 在跑时 B 照常派', async () => {
    const a = makeDeck('dck_a');
    const b = makeDeck('dck_b');
    const run = gatedRunFn();
    try {
      const r1 = await generateDeckForArtifact({ deck: a, conversationId: 'c', broadcast });
      expect(r1.ok).toBe(true);
      // 不同 projectId 也行——去重判据是 artifactId 不是 projectKey
      const r2 = await generateDeckForArtifact({ deck: b, conversationId: 'c', broadcast });
      expect(r2.ok).toBe(true); // 同 key 排队但允许派（不是重复）
      expect(deckTaskState(b.id)).toBe('queued');

      run.releaseAll();
      await tick();
      run.releaseAll();
      await tick();
    } finally {
      run.restore();
    }
  });
});
