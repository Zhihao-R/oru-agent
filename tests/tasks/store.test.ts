/**
 * tasks/store 并发 RMW 回归
 *
 * 目标问题：markAnnounced 必须锁内 RMW（只打 announcedAt、不碰 status），否则与并发的终态写
 * （router cancel 时 catch 落 status='failed'）互相覆盖——这是「RMW 整块必须入锁」铁律的体现。
 *
 * 必须通过 process.env.ORU_DIR 重定向 tmpdir，store 用 await import 动态加载，
 * 避免 runtime/paths.ts 在 module load 时把 ORU_DIR 锁死。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SubagentTask } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-tasks-store-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'test-owner';
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => OWNER,
}));

function baseTask(id: string): SubagentTask {
  return {
    id,
    ownerId: OWNER,
    agentId: 'twin',
    conversationId: 'c1',
    proposalId: 'p1',
    proposalTitle: '修复滚动',
    targetProjectId: null,
    status: 'running',
    baselineCommit: null,
    summary: null,
    errorMessage: null,
    startedAt: 0,
    finishedAt: null,
    profileId: 'project-coder',
    endTag: null,
    affectedPaths: [],
    commitsCreated: [],
    announcedAt: null,
    featureBranch: null,
  };
}

describe('tasks/store · 并发 RMW 不丢更新', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('markAnnounced 撞上 updateTaskStatus(failed)：status 与 announcedAt 都保留', async () => {
    const { createTask, markAnnounced, updateTaskStatus, getTask } = await import(
      '../../electron/main/tasks/store'
    );
    const id = 'race1';
    await createTask(baseTask(id));
    // 模拟 router cancel 的 markAnnounced 撞上 runTask catch 的 status='failed'
    await Promise.all([
      markAnnounced(id),
      updateTaskStatus(id, 'failed', { errorMessage: 'aborted' }),
    ]);
    const t = await getTask(id);
    expect(t?.status).toBe('failed'); // 终态没被 markAnnounced 回退成 running
    expect(t?.announcedAt).not.toBeNull(); // 播报抑制标记没被 status 写覆盖
  });

  it('反向顺序同样不丢（updateTaskStatus 先、markAnnounced 后）', async () => {
    const { createTask, markAnnounced, updateTaskStatus, getTask } = await import(
      '../../electron/main/tasks/store'
    );
    const id = 'race2';
    await createTask(baseTask(id));
    await Promise.all([
      updateTaskStatus(id, 'failed', { errorMessage: 'x' }),
      markAnnounced(id),
    ]);
    const t = await getTask(id);
    expect(t?.status).toBe('failed');
    expect(t?.announcedAt).not.toBeNull();
  });
});

describe('tasks/store · getLastProgress 工具名前缀归一', () => {
  beforeAll(async () => {
    await fs.mkdir(ORU_DIR, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('claude-code 事件名带 mcp__oru__ 前缀，文案剥前缀不露内部代号（回归）', async () => {
    const { createTask, appendTaskEvent, getLastProgress } = await import(
      '../../electron/main/tasks/store'
    );
    const id = 'prefix1';
    await createTask(baseTask(id));
    // 流文件行格式与 tasks/stream.ts 落盘一致：{ event } 包一层
    await appendTaskEvent(id, { event: { type: 'tool_use', name: 'mcp__oru__web_search' } });
    expect(await getLastProgress(id)).toBe('调用工具：web_search');
  });
});

// ─── S06 · G128/G129：格式版本号 + 迁移前原样副本 ───────────────────────────
describe('tasks/store — 格式版本号（S06）', () => {
  const dir = join(ORU_DIR, 'users', OWNER, 'tasks');
  beforeAll(async () => {
    await fs.mkdir(dir, { recursive: true });
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });

  it('新建落盘带版本 envelope，get round-trip 保真', async () => {
    const store = await import('../../electron/main/tasks/store');
    await store.createTask(baseTask('v_new'));
    const raw = JSON.parse(await fs.readFile(join(dir, 'v_new.json'), 'utf-8'));
    expect(typeof raw.version).toBe('number');
    expect(raw.task.id).toBe('v_new');
    expect(await store.getTask('v_new')).toEqual(baseTask('v_new'));
  });

  it('老裸格式读得出 + 首次读落原样副本 + 副本不被 list 扫成任务（G129）', async () => {
    const store = await import('../../electron/main/tasks/store');
    const bare = JSON.stringify({ ...baseTask('v_old'), proposalTitle: '老格式派工' });
    await fs.writeFile(join(dir, 'v_old.json'), bare);
    const t = await store.getTask('v_old');
    expect(t?.proposalTitle).toBe('老格式派工');
    expect(await fs.readFile(join(dir, 'v_old.json.pre-v1.bak'), 'utf-8')).toBe(bare);
    const forConv = await store.listTasksForConversation('c1');
    expect(forConv.filter((x) => x.id === 'v_old')).toHaveLength(1);
  });

  it('未来版本文件 → 跳过不读、patch 不写、字节不动', async () => {
    const store = await import('../../electron/main/tasks/store');
    const futureBytes = JSON.stringify({ version: 99, task: { id: 'v_future', conversationId: 'c1' } });
    await fs.writeFile(join(dir, 'v_future.json'), futureBytes);
    expect(await store.getTask('v_future')).toBeNull();
    expect((await store.listTasksForConversation('c1')).map((x) => x.id)).not.toContain('v_future');
    expect(await store.patchTask('v_future', { status: 'failed' })).toBeNull();
    expect(await fs.readFile(join(dir, 'v_future.json'), 'utf-8')).toBe(futureBytes);
  });
});
