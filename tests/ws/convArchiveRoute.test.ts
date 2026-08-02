/**
 * conv.archive / conv.delete 路由层回归（钉死"列表里点删除其实是硬删、不是归档"这次语义整理）：
 * - conv.archive → 对话仍在 conv.state 列表、带 archivedAt（收进「已归档」可恢复）。
 * - conv.delete → 对话从列表移除（彻底删除）。
 * 验的是 route() 把两个请求分发到了正确的 store 函数——store 单测证不了路由接错（接反才是这次的病灶）。
 *
 * ORU_DIR 范式：顶层先设 env，route / store 全动态 import，避免 paths.ts 在 module load 时锁死 ORU_DIR。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerEvent } from '@shared/protocol';
import type { Conversation } from '@shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-conv-archive-route-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

function convStateConversations(events: ServerEvent[]): Conversation[] | null {
  const ev = events.find((e) => e.type === 'conv.state');
  return ev && ev.type === 'conv.state' ? ev.conversations : null;
}

describe('conv.archive / conv.delete 路由分发', () => {
  it('conv.archive：对话留在列表、带 archivedAt（归档=可恢复，不是移除）', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-route-archive';
    const c = await createConversation({ agentId, title: '待归档', kind: 'sub' });

    const events: ServerEvent[] = [];
    await route(
      { type: 'conv.archive', reqId: 'a1', agentId, conversationId: c.id },
      () => {},
      (ev) => events.push(ev),
    );

    const got = convStateConversations(events)?.find((x) => x.id === c.id);
    expect(got).toBeDefined(); // 仍在列表 = 没被删
    expect(typeof got?.archivedAt).toBe('number'); // 带归档时间戳
  });

  it('conv.delete：对话从列表移除（彻底删除）', async () => {
    const { route } = await import('../../electron/main/ws/router');
    const { createConversation } = await import('../../electron/main/conversations/store');
    const agentId = 'agent-route-delete';
    const c = await createConversation({ agentId, title: '待删除', kind: 'sub' });

    const events: ServerEvent[] = [];
    await route(
      { type: 'conv.delete', reqId: 'd1', agentId, conversationId: c.id },
      () => {},
      (ev) => events.push(ev),
    );

    expect(convStateConversations(events)?.find((x) => x.id === c.id)).toBeUndefined();
  });
});
