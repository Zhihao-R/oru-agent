/**
 * autoArchiver（对话归档）核心判定与编排：
 * - pickConversationsToArchive：纯判定，clamp thresholdHours≥1（堵 0/负数清空活跃区）。
 * - runAutoArchive：enabled 开关 + 遍历 agent 归档超阈值 sub + 广播回调；真实 store 落盘往返。
 *
 * 后端扫描刻意不判 active（"正在看的对话"豁免在前端显示兜底，见 tech design §二）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { Conversation } from '@shared/types';
import { sandboxOruDir } from '../helpers/oruDirSandbox';

const ORU_DIR = sandboxOruDir('autoarchiver');
const OWNER = 'local-user';

function indexPath(agentId: string): string {
  return join(ORU_DIR, 'users', OWNER, 'conversations', agentId, 'index.json');
}
async function readIndex(agentId: string): Promise<Conversation[]> {
  // D5：index.json 现为 versioned envelope { version, conversations }；兼容裸数组(v1)。
  const env = JSON.parse(await fs.readFile(indexPath(agentId), 'utf-8'));
  return (Array.isArray(env) ? env : env.conversations) as Conversation[];
}
async function setUpdatedAt(agentId: string, convId: string, updatedAt: number): Promise<void> {
  const list = await readIndex(agentId);
  const idx = list.findIndex((c) => c.id === convId);
  list[idx] = { ...list[idx], updatedAt };
  // 写回 envelope（与 store.saveIndex 同格式），下次 loadIndex 零迁移读回。
  await fs.writeFile(indexPath(agentId), JSON.stringify({ version: 2, conversations: list }), 'utf-8');
}

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
function conv(id: string, updatedAt: number, archivedAt?: number): Conversation {
  return {
    id,
    ownerId: OWNER,
    agentId: 'a1',
    kind: 'sub',
    title: id,
    sdkSessionId: null,
    createdAt: 0,
    updatedAt,
    archivedAt,
  };
}

describe('pickConversationsToArchive', () => {
  it('未归档且超阈值 → 选中', async () => {
    const { pickConversationsToArchive } = await import(
      '../../electron/main/conversations/autoArchiver'
    );
    expect(pickConversationsToArchive([conv('old', NOW - 8 * HOUR)], NOW, 7)).toEqual(['old']);
  });

  it('已归档 → 不选（archivedAt 非空）', async () => {
    const { pickConversationsToArchive } = await import(
      '../../electron/main/conversations/autoArchiver'
    );
    expect(
      pickConversationsToArchive([conv('done', NOW - 100 * HOUR, NOW - 50 * HOUR)], NOW, 7),
    ).toEqual([]);
  });

  it('未超阈值 → 不选', async () => {
    const { pickConversationsToArchive } = await import(
      '../../electron/main/conversations/autoArchiver'
    );
    expect(pickConversationsToArchive([conv('fresh', NOW - 2 * HOUR)], NOW, 7)).toEqual([]);
  });

  it('thresholdHours<=0 被 clamp 到 1，不会把刚活跃的清空', async () => {
    const { pickConversationsToArchive } = await import(
      '../../electron/main/conversations/autoArchiver'
    );
    // 半小时前活跃：阈值 0 若不 clamp 会 now-updatedAt>0 命中；clamp 到 1h 则不选
    expect(pickConversationsToArchive([conv('just', NOW - HOUR / 2)], NOW, 0)).toEqual([]);
    // 2 小时前：clamp 到 1h 后该归档
    expect(pickConversationsToArchive([conv('older', NOW - 2 * HOUR)], NOW, 0)).toEqual(['older']);
  });
});

describe('runAutoArchive', () => {
  it('enabled=true：超阈值 sub 真归档 + 触发广播回调；新对话不动', async () => {
    const { createConversation } = await import('../../electron/main/conversations/store');
    const { runAutoArchive } = await import('../../electron/main/conversations/autoArchiver');
    const agentId = 'a-run-on';
    const old = await createConversation({ agentId, title: '旧', kind: 'sub' });
    const fresh = await createConversation({ agentId, title: '新', kind: 'sub' });
    await setUpdatedAt(agentId, old.id, NOW - 8 * HOUR);
    await setUpdatedAt(agentId, fresh.id, NOW - 1 * HOUR);

    const broadcasts: string[] = [];
    const ids = await runAutoArchive({
      agentIds: [agentId],
      settings: { enabled: true, thresholdHours: 7 },
      now: NOW,
      onArchived: (aid) => broadcasts.push(aid),
    });

    expect(ids).toEqual([old.id]);
    expect(broadcasts).toEqual([agentId]);
    const disk = await readIndex(agentId);
    expect(typeof disk.find((c) => c.id === old.id)?.archivedAt).toBe('number');
    expect(disk.find((c) => c.id === fresh.id)?.archivedAt).toBeUndefined();
  });

  it('enabled=false：什么都不归档、不广播', async () => {
    const { createConversation } = await import('../../electron/main/conversations/store');
    const { runAutoArchive } = await import('../../electron/main/conversations/autoArchiver');
    const agentId = 'a-run-off';
    const old = await createConversation({ agentId, title: '旧', kind: 'sub' });
    await setUpdatedAt(agentId, old.id, NOW - 100 * HOUR);

    const broadcasts: string[] = [];
    const ids = await runAutoArchive({
      agentIds: [agentId],
      settings: { enabled: false, thresholdHours: 7 },
      now: NOW,
      onArchived: (aid) => broadcasts.push(aid),
    });

    expect(ids).toEqual([]);
    expect(broadcasts).toEqual([]);
    const disk = await readIndex(agentId);
    expect(disk.find((c) => c.id === old.id)?.archivedAt).toBeUndefined();
  });
});
