/**
 * conversations/store 已读水位 lastSeenAt（通知中心 · 技术设计 §5.1）：
 * - markConversationSeen 写 lastSeenAt，落盘存活（loadIndex→rehydrate 往返不丢，与 archivedAt 同坑）。
 * - 与 updatedAt 正交：appendMessage 刷新 updatedAt 但不碰 lastSeenAt——这正是"Oru 后台跑完→重新未读"
 *   的机制（updatedAt 超过 lastSeenAt 即未读），故 appendMessage 绝不能顺手抹 lastSeenAt。
 *
 * 真实落盘往返（读 index.json 原文），不 mock——rehydrate 漏透传 lastSeenAt 会让已读状态
 * 在任何一次 loadIndex 后丢失，必须验到磁盘层。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChatMessage, Conversation } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-conv-lastseen-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const OWNER = 'local-user';

function indexPath(agentId: string): string {
  return join(ORU_DIR, 'users', OWNER, 'conversations', agentId, 'index.json');
}
async function readIndex(agentId: string): Promise<Conversation[]> {
  // D5：index.json 现为 versioned envelope { version, conversations }；兼容裸数组(v1)。
  const env = JSON.parse(await fs.readFile(indexPath(agentId), 'utf-8'));
  return (Array.isArray(env) ? env : env.conversations) as Conversation[];
}
function makeMessage(conversationId: string, text: string): ChatMessage {
  return {
    id: `msg_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
    conversationId,
    role: 'user',
    text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
  };
}

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('conversations/store - 已读水位 lastSeenAt', () => {
  it('markConversationSeen 写入 lastSeenAt 并落盘存活（rehydrate 往返不丢）', async () => {
    const { createConversation, markConversationSeen, listConversations } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-seen-set';
    const c = await createConversation({ agentId, title: '新对话', kind: 'sub' });
    expect(c.lastSeenAt).toBeUndefined();

    const seenAt = Date.now();
    await markConversationSeen(agentId, c.id, seenAt);

    const onDisk = (await readIndex(agentId)).find((x) => x.id === c.id);
    expect(onDisk?.lastSeenAt).toBe(seenAt);

    // 再走一次 loadIndex（listConversations）确认 rehydrate 透传，不被抹掉
    const reloaded = (await listConversations(agentId)).find((x) => x.id === c.id);
    expect(reloaded?.lastSeenAt).toBe(seenAt);
  });

  it('appendMessage 刷新 updatedAt 但不碰 lastSeenAt（后台跑完→重新未读）', async () => {
    const { createConversation, markConversationSeen, appendMessage } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-seen-append';
    const c = await createConversation({ agentId, title: '看过后又来活', kind: 'sub' });
    const seenAt = Date.now();
    await markConversationSeen(agentId, c.id, seenAt);
    await appendMessage(agentId, c.id, makeMessage(c.id, '后台又产出'));

    const onDisk = (await readIndex(agentId)).find((x) => x.id === c.id);
    expect(onDisk?.lastSeenAt).toBe(seenAt); // 不被抹
    expect(onDisk!.updatedAt).toBeGreaterThanOrEqual(seenAt); // updatedAt 被刷 → 未读
  });

  it('水位只升不降：旧 seenAt 不覆盖已写入的新 seenAt（enqueue 串行后的回退防护）', async () => {
    const { createConversation, markConversationSeen, listConversations } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-seen-monotonic';
    const c = await createConversation({ agentId, title: '水位', kind: 'sub' });
    await markConversationSeen(agentId, c.id, 2000); // 先写较新的
    await markConversationSeen(agentId, c.id, 1000); // 再来个较旧的——应被挡住
    const reloaded = (await listConversations(agentId)).find((x) => x.id === c.id);
    expect(reloaded?.lastSeenAt).toBe(2000);
  });

  it('markConversationSeen 对不存在的对话静默返回（不抛）', async () => {
    const { markConversationSeen } = await import('../../electron/main/conversations/store');
    await expect(markConversationSeen('agent-seen-missing', 'nope', Date.now())).resolves.toBeUndefined();
  });
});
