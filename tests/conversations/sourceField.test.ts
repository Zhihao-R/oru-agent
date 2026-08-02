/**
 * Conversation.source 来源标识（tech design §4.2）——平台会话带 {platform,chatId}，桌面会话恒空；
 * 这是「认得出哪条来自飞书 / Discord」的唯一依据，必须穿透落盘往返存活。
 * getOrCreateConversation 按 source 查/建：同来源第二次拿到同一条，不同来源各建一条。
 *
 * ORU_DIR 范式同 tests/conversations/store.test.ts（顶层设 env + 动态 import + 验落盘往返）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-conv-source-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('Conversation.source 落盘往返', () => {
  it('createConversation 带 source，loadIndex 重读仍存活', async () => {
    const { createConversation, getConversation } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-source-survive';
    const conv = await createConversation({
      agentId,
      title: '飞书 · 与你的私聊',
      kind: 'sub',
      source: { platform: 'feishu', chatId: 'oc_x' },
    });
    expect(conv.source).toEqual({ platform: 'feishu', chatId: 'oc_x' });

    const round = await getConversation(agentId, conv.id);
    expect(round.source).toEqual({ platform: 'feishu', chatId: 'oc_x' });
  });

  it('桌面会话不带 source → undefined（向后兼容）', async () => {
    const { createConversation } = await import('../../electron/main/conversations/store');
    const conv = await createConversation({ agentId: 'agent-no-source', title: '子对话', kind: 'sub' });
    expect(conv.source).toBeUndefined();
  });
});

describe('getOrCreateConversation 按 source 查/建', () => {
  it('同来源第二次拿到同一条（不重复建）', async () => {
    const { getOrCreateConversation } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-getorcreate';
    const source = { platform: 'discord' as const, chatId: 'dm_1' };
    const a = await getOrCreateConversation(agentId, source, 'Discord 私聊');
    const b = await getOrCreateConversation(agentId, source, 'Discord 私聊');
    expect(b.id).toBe(a.id);
  });

  it('不同来源各建一条', async () => {
    const { getOrCreateConversation } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-getorcreate-2';
    const a = await getOrCreateConversation(agentId, { platform: 'feishu', chatId: 'c1' }, 'A');
    const b = await getOrCreateConversation(agentId, { platform: 'feishu', chatId: 'c2' }, 'B');
    expect(b.id).not.toBe(a.id);
  });
});

describe('渠道寻址排除已归档对话（S11 · G83）', () => {
  it('绑定对话归档后 findConversationBySource 查不到 → getOrCreateConversation 静默新开一段', async () => {
    const { getOrCreateConversation, findConversationBySource, archiveConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-g83-newseg';
    const source = { platform: 'feishu' as const, chatId: 'oc_seg' };

    const first = await getOrCreateConversation(agentId, source, '第一段');
    await archiveConversation(agentId, first.id); // 归档 = 这一段完结
    // 寻址从不解档：归档的绑定对话查不到
    expect(await findConversationBySource(agentId, source)).toBeNull();
    // 下一条渠道消息据此新开一段（不翻出旧对话续写）
    const second = await getOrCreateConversation(agentId, source, '第二段');
    expect(second.id).not.toBe(first.id);
    expect(second.archivedAt).toBeUndefined(); // 新段活跃
    expect(second.source).toEqual(source); // 绑同一来源
  });

  it('未归档的绑定对话照常续用（同一段接续）', async () => {
    const { getOrCreateConversation } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-g83-continue';
    const source = { platform: 'discord' as const, chatId: 'dm_seg' };
    const a = await getOrCreateConversation(agentId, source, '活跃段');
    const b = await getOrCreateConversation(agentId, source, '活跃段');
    expect(b.id).toBe(a.id); // 活跃即续用
  });
});

describe('getOrCreateConversation 并发原子（查+建入锁）', () => {
  it('同来源并发（渠道入站 × 定时任务渠道落点）只建一条对话', async () => {
    const { getOrCreateConversation, listConversations } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-concurrent-getorcreate';
    const source = { platform: 'feishu' as const, chatId: 'oc_race' };
    // 两路并发：gateway 入站与定时任务落点同时对同一渠道会话查/建
    const [a, b] = await Promise.all([
      getOrCreateConversation(agentId, source, '入站'),
      getOrCreateConversation(agentId, source, '定时任务'),
    ]);
    expect(a.id).toBe(b.id); // 「每渠道一条活跃对话」不变量
    const all = await listConversations(agentId);
    expect(all.filter((c) => c.source?.chatId === 'oc_race')).toHaveLength(1);
  });
});
