/**
 * memory.undo 撤销状态落盘 —— 撤销成功后 memoryRecord.undone 持久化到对话 JSONL。
 *
 * 缺陷回归：撤销状态此前只活在前端内存（chat.memoryUndone 事件回推），重载对话即丢，
 * 卡片又显示成可撤销——再点一次必失败（episode 已在回收站）。
 *
 * 两条承重点：
 *   1. episode 撤销成功 → 重新从磁盘读历史，undone === true 且其余 memoryRecord 字段逐字未变
 *      （守住 patchMessage 浅合并「整体替换 memoryRecord」的抹字段坑）
 *   2. 档案类撤销失败（changed-since）→ undone 不被置 true
 *
 * 使用真实 I/O（ORU_DIR 隔离到 tmpdir）走真 route()。**不 mock memory/trash**——episode
 * 主路径正是 moveToTrash，mock 掉就静默假绿；memory/store 同样保持真实（trash 依赖其
 * removeIndexEntry）。
 *
 * ORU_DIR 陷阱：vi.mock 被 hoisted 到 env 赋值之前 → 用 vi.hoisted 注入（Pattern B）。
 */
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Broadcast, Reply } from '../../electron/main/ws/server';
import type { ServerEventPayload } from '@shared/protocol';
import type { ChatMessage, MemoryRecordPayload } from '@shared/types';

const { ORU_DIR } = vi.hoisted(() => {
  const path = require('node:path') as typeof import('node:path');
  const os = require('node:os') as typeof import('node:os');
  const ORU_DIR = path.join(os.tmpdir(), `oru-test-memundo-${Date.now()}`);
  process.env.ORU_DIR = ORU_DIR;
  return { ORU_DIR };
});

const OWNER = 'owner-undo';
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => OWNER,
}));

// 注册表里其他 handler 的重依赖——不影响 memory.undo，mock 防止启动时报错
vi.mock('../../electron/main/memory/dreamScheduler', () => ({ runOnce: vi.fn() }));
vi.mock('../../electron/main/memory/applyOps', () => ({ applyOps: vi.fn() }));
vi.mock('../../electron/main/memory/projectProfile', () => ({ readProjectProfile: vi.fn() }));
vi.mock('../../electron/main/memory/projectList', () => ({
  readAllProjectListEntriesForUI: vi.fn(),
}));

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

afterEach(() => vi.clearAllMocks());

function harness() {
  const replies: ServerEventPayload[] = [];
  const broadcasts: ServerEventPayload[] = [];
  const reply: Reply = (_reqId, ev) => {
    replies.push(ev);
  };
  const broadcast: Broadcast = (ev) => {
    broadcasts.push(ev);
  };
  return { reply, broadcast, replies, broadcasts };
}

function mkMemoryCard(
  conversationId: string,
  id: string,
  record: MemoryRecordPayload,
): ChatMessage {
  return {
    id,
    conversationId,
    role: 'system',
    text: `已记下 ${record.preview}`,
    toolCalls: [],
    createdAt: 1000,
    done: true,
    kind: 'memory-record',
    memoryRecord: record,
  };
}

describe('memory.undo 撤销状态落盘', () => {
  it('episode 撤销成功 → undone 落盘，其余 memoryRecord 字段逐字未变', { timeout: 15000 }, async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { appendMessage, readHistoryForOwner } = await import(
      '../../electron/main/conversations/store'
    );
    const { memoryRoot } = await import('../../electron/main/memory/paths');

    const agentId = 'agt_undo';
    const convId = 'cnv_undo';
    const relPath = 'agents/twin/episodes/2026-07-28-undo-test.md';
    const record: MemoryRecordPayload = {
      relPath,
      preview: '要撤销的记忆',
      scope: 'agent',
      type: 'episode',
    };
    await appendMessage(agentId, convId, mkMemoryCard(convId, 'msg_mem_1', record));
    // 造出真实 episode 文件——moveToTrash 是真实现，挪不到文件也幂等，但这里让主路径真跑一遍
    const abs = join(memoryRoot(OWNER), relPath);
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.writeFile(abs, '---\ntitle: t\n---\n正文', 'utf-8');

    const h = harness();
    await route(
      {
        type: 'memory.undo',
        reqId: 'u1',
        agentId,
        conversationId: convId,
        messageId: 'msg_mem_1',
        relPath,
      },
      h.reply,
      h.broadcast,
    );

    expect(h.replies[0]?.type).toBe('ack');
    expect(h.broadcasts.some((ev) => ev.type === 'chat.memoryUndone')).toBe(true);

    // 重新从磁盘读历史——验的就是持久化，不认内存态
    const msgs = await readHistoryForOwner(OWNER, agentId, convId);
    const card = msgs.find((m) => m.id === 'msg_mem_1');
    expect(card?.memoryRecord).toEqual({ ...record, undone: true });
  });

  it('档案类撤销失败（changed-since：文件不存在）→ undone 不落盘', { timeout: 15000 }, async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { appendMessage, readHistoryForOwner } = await import(
      '../../electron/main/conversations/store'
    );

    const agentId = 'agt_undo_fail';
    const convId = 'cnv_undo_fail';
    const record: MemoryRecordPayload = {
      relPath: 'agents/twin/profile.md',
      preview: '档案修改',
      scope: 'agent',
      type: 'self',
      revertHash: 'deadbeef', // 文件不存在 → resolveRevertTarget 回 changed-since
    };
    await appendMessage(agentId, convId, mkMemoryCard(convId, 'msg_mem_2', record));

    const h = harness();
    await route(
      {
        type: 'memory.undo',
        reqId: 'u2',
        agentId,
        conversationId: convId,
        messageId: 'msg_mem_2',
        relPath: record.relPath,
        revertHash: record.revertHash,
      },
      h.reply,
      h.broadcast,
    );

    expect(h.replies[0]?.type).toBe('error');
    const msgs = await readHistoryForOwner(OWNER, agentId, convId);
    expect(msgs.find((m) => m.id === 'msg_mem_2')?.memoryRecord?.undone).toBeUndefined();
  });
});
