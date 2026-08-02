/**
 * conversations/store 归档状态（对话归档）：
 * - archiveConversation 写 archivedAt，落盘存活（含 loadIndex→rehydrate 往返不丢字段）。
 * - 解档落点（PM 2026-07-11）：对话内产生新消息（appendMessage，AI/用户都算）或清空
 *   （clearConversation）清掉 archivedAt；markConversationSeen（打开看一眼 / 通知中心「忽略」）
 *   **不解档**（纯翻看不激活）。渠道消息不落进归档对话（寻址排除、另起一段，S11 · G83），故不激活旧段。
 * - 与归档正交的写路径：renameConversation 刷新 updatedAt 但不碰 archivedAt。
 *
 * 真实落盘往返（读 index.json 原文验字节），不 mock store 依赖——rehydrate 漏透传
 * archivedAt 会让归档状态在任何一次 loadIndex 后丢失，必须验到磁盘层。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, Conversation } from '@shared/types';
import { sandboxOruDir } from '../helpers/oruDirSandbox';

const ORU_DIR = sandboxOruDir('conv-archive');
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

describe('conversations/store - 归档状态', () => {
  it('archiveConversation 写入 archivedAt 并落盘存活', async () => {
    const { createConversation, archiveConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-archive-set';
    const c = await createConversation({ agentId, title: '旧对话', kind: 'sub' });
    expect(c.archivedAt).toBeUndefined();

    const archived = await archiveConversation(agentId, c.id);
    expect(typeof archived?.archivedAt).toBe('number');

    const onDisk = (await readIndex(agentId)).find((x) => x.id === c.id);
    expect(typeof onDisk?.archivedAt).toBe('number');
  });

  it('归档后 appendMessage 解档（PM 2026-07-11：对话内产生新消息=激活，AI/用户都算）', async () => {
    const { createConversation, archiveConversation, appendMessage } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-archive-append';
    const c = await createConversation({ agentId, title: '归档后又发消息', kind: 'sub' });
    await archiveConversation(agentId, c.id);
    await appendMessage(agentId, c.id, makeMessage(c.id, '在这条对话里继续发言'));

    const onDisk = (await readIndex(agentId)).find((x) => x.id === c.id);
    expect(onDisk?.archivedAt).toBeUndefined(); // 新消息=激活、回活跃流
  });

  it('markConversationSeen 不解档（PM 2026-07-11：打开/通知忽略只标已读，纯翻看不激活）', async () => {
    const { createConversation, archiveConversation, markConversationSeen } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-archive-markseen-nounarchive';
    const c = await createConversation({ agentId, title: '归档后被忽略', kind: 'sub' });
    const archived = await archiveConversation(agentId, c.id);
    const ts = archived?.archivedAt;
    // 打开对话看一眼 / 通知中心点「忽略」都只标已读、不产生新消息——归档态必须保持（纯翻看不激活）
    await markConversationSeen(agentId, c.id, Date.now());

    const onDisk = (await readIndex(agentId)).find((x) => x.id === c.id);
    expect(onDisk?.archivedAt).toBe(ts); // 仍归档
    expect(typeof onDisk?.lastSeenAt).toBe('number'); // 水位照常刷
  });

  it('归档后 clearConversation 清掉 archivedAt（清空=重新启用）', async () => {
    const { createConversation, archiveConversation, clearConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-archive-clear';
    const c = await createConversation({ agentId, title: '归档后清空', kind: 'sub' });
    await archiveConversation(agentId, c.id);
    await clearConversation(agentId, c.id);

    const onDisk = (await readIndex(agentId)).find((x) => x.id === c.id);
    expect(onDisk?.archivedAt).toBeUndefined();
  });

  // ── 归档 vs 彻底删除是两套机制（钉死「删除其实是硬删、不是归档」这次澄清）──
  // 归档：对话留在索引、只多 archivedAt（「已归档」抽屉据此显示，可恢复）。
  // 彻底删除：从索引移除、历史 jsonl 改名成 .bak（应用内不可见，不进任何抽屉）。
  it('archiveConversation 保留索引条目（只多 archivedAt），deleteConversation 移除条目', async () => {
    const { createConversation, archiveConversation, deleteConversation, appendMessage } =
      await import('../../electron/main/conversations/store');
    const agentId = 'agent-archive-vs-delete';

    // 归档：仍在索引、带 archivedAt
    const a = await createConversation({ agentId, title: '要归档的', kind: 'sub' });
    await archiveConversation(agentId, a.id);
    const afterArchive = (await readIndex(agentId)).find((x) => x.id === a.id);
    expect(typeof afterArchive?.archivedAt).toBe('number');

    // 彻底删除：先落一条消息造出 jsonl，删后索引里没了、磁盘上多个 .bak
    const d = await createConversation({ agentId, title: '要删的', kind: 'sub' });
    await appendMessage(agentId, d.id, makeMessage(d.id, '一句历史'));
    const dir = join(ORU_DIR, 'users', OWNER, 'conversations', agentId);
    await deleteConversation(agentId, d.id);
    expect((await readIndex(agentId)).find((x) => x.id === d.id)).toBeUndefined();
    const baks = (await fs.readdir(dir)).filter((f) => f.startsWith(`${d.id}.jsonl.bak.`));
    expect(baks.length).toBe(1);
  });

  it('归档后 renameConversation 不碰 archivedAt（改名与归档正交）', async () => {
    const { createConversation, archiveConversation, renameConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-archive-rename';
    const c = await createConversation({ agentId, title: '归档后改名', kind: 'sub' });
    await archiveConversation(agentId, c.id);
    await renameConversation(agentId, c.id, '新名字');

    const onDisk = (await readIndex(agentId)).find((x) => x.id === c.id);
    expect(typeof onDisk?.archivedAt).toBe('number');
  });

  // ── 并发护栏：扫描"快照命中"到"执行归档"之间用户发了消息，不能把刚活跃的对话误归档 ──
  it('archiveConversation onlyIfInactiveSince：updatedAt 晚于截止点 → 跳过返回 null、不归档', async () => {
    const { createConversation, archiveConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-archive-guard-active';
    const c = await createConversation({ agentId, title: '刚发过消息', kind: 'sub' });
    // createConversation 的 updatedAt≈现在；截止点设在 1970 → updatedAt 远晚于它 → 重检失败、跳过
    const r = await archiveConversation(agentId, c.id, { onlyIfInactiveSince: 1 });
    expect(r).toBeNull();
    const onDisk = (await readIndex(agentId)).find((x) => x.id === c.id);
    expect(onDisk?.archivedAt).toBeUndefined();
  });

  it('archiveConversation onlyIfInactiveSince：已归档 → 跳过、不覆盖原 archivedAt', async () => {
    const { createConversation, archiveConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const agentId = 'agent-archive-guard-done';
    const c = await createConversation({ agentId, title: '已归档', kind: 'sub' });
    const first = await archiveConversation(agentId, c.id); // 无 guard 先归档
    const ts = first?.archivedAt;
    // 截止点设在很远的未来：updatedAt 条件不触发，但 archivedAt 已存在 → 仍跳过
    const r = await archiveConversation(agentId, c.id, {
      onlyIfInactiveSince: 9_999_999_999_999,
    });
    expect(r).toBeNull();
    const onDisk = (await readIndex(agentId)).find((x) => x.id === c.id);
    expect(onDisk?.archivedAt).toBe(ts); // 原 archivedAt 不被覆盖
  });
});
