/**
 * /new 五步接线（gatewayWiring · 斜杠命令补全 plan §3）——占闸 → 刹车 → 归档 → 释闸。
 *
 * 钉住的承重行为（gateway fake 测试只验回执映射，五步本体在这里）：
 *   1. 顺序：刹车先于归档（appendMessage 解档复活路径靠这条序封死——后台任务不清完，
 *      它们的完成播报会往旧对话写消息、归档即复活）。C1 回归。
 *   2. 空闲全流：归档生效（渠道寻址查不到旧对话、旧对话留在归档区）+ 回执「已开新篇」+ 闸释放。
 *   3. 忙时拒绝：闸被占 → 回执提示先 /stop、不归档、不刹车。
 *   4. 释闸交还：占闸窗口期落进旧队列的零星项走 handback（不重投不丢弃）。
 *   5. 无绑定会话：回执「还没有会话」，不动手。
 *
 * 模式对齐 stopBrake.test.ts：真 ORU_DIR / 真 store / 真 wiring，只桩刹车内部各件。
 * 顺序钉法：archiveConversation 包一层记录调用序后委托真实现（归档效果本身也要验）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlatformAdapter } from '../../electron/main/platform/adapter';
import type { MessageEvent, SendResult, SessionSource } from '@shared/platform/message';
import type { ServerEvent } from '@shared/protocol';

const ORU_DIR = join(tmpdir(), `oru-test-new-archive-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const { callOrder } = vi.hoisted(() => ({ callOrder: [] as string[] }));

vi.mock('../../electron/main/agent/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/agent/runner')>();
  return {
    ...actual,
    abortConversation: vi.fn(() => {
      callOrder.push('brake');
      return true;
    }) satisfies typeof actual.abortConversation,
  };
});
vi.mock('../../electron/main/tasks/subagentRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/subagentRunner')>();
  return {
    ...actual,
    cancelTasksForConversation: vi.fn(() => []) satisfies typeof actual.cancelTasksForConversation,
  };
});
vi.mock('../../electron/main/proposals/executeBashProposal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/proposals/executeBashProposal')>();
  return {
    ...actual,
    killBashForConversation: vi.fn(() => {}) satisfies typeof actual.killBashForConversation,
  };
});
vi.mock('../../electron/main/conversations/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/conversations/store')>();
  return {
    ...actual,
    // 记录调用序后委托真实现——归档效果本身（归档区/寻址排除）由断言真状态验收
    archiveConversation: vi.fn((...args: Parameters<typeof actual.archiveConversation>) => {
      callOrder.push('archive');
      return actual.archiveConversation(...args);
    }) satisfies typeof actual.archiveConversation,
  };
});

import { abortConversation } from '../../electron/main/agent/runner';
import { cancelTasksForConversation } from '../../electron/main/tasks/subagentRunner';
import { archiveConversation } from '../../electron/main/conversations/store';

const src: SessionSource = {
  platform: 'feishu',
  chatId: 'oc_new',
  chatType: 'dm',
  userId: 'ou_new',
  userIdAlt: 'un_new',
  raw: {},
};
const newEvt = (chatId = 'oc_new'): MessageEvent => ({
  text: '/new',
  messageId: `m_${Math.random()}`,
  source: { ...src, chatId },
  command: { kind: 'new' },
});

function makeFakeAdapter() {
  const sent: Array<{ chatId: string; content: string }> = [];
  const adapter: PlatformAdapter = {
    platform: 'feishu',
    maxMessageLength: 8000,
    maxFileBytes: 1024,
    connect: async () => true,
    disconnect: async () => {},
    send: async (chatId, content): Promise<SendResult> => {
      sent.push({ chatId, content });
      return { ok: true, messageId: `m_${sent.length}` };
    },
  };
  return { adapter, sent };
}

let agentId: string;

async function makeGateway(adapter: PlatformAdapter, events: ServerEvent[]) {
  const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
  const { PairingManager } = await import('../../electron/main/platform/pairing');
  const { loadWhitelist, saveWhitelist, resolveRemoteAgentId } = await import(
    '../../electron/main/platform/platformSettings'
  );
  return createPlatformGateway(adapter, {
    pairing: new PairingManager({ now: () => Date.now() }),
    loadWhitelist,
    saveWhitelist,
    resolveRemoteAgentId,
    broadcast: (ev) => events.push(ev),
  });
}

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
  const { saveWhitelist, setRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
  await saveWhitelist(['un_new']);
  await setRemoteAgentId(agentId);
  // 回执语言跟 owner 界面语言——钉 zh 文案先设中文
  const { updateSettings } = await import('../../electron/main/projects/store');
  await updateSettings({ language: 'zh' });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
});

describe('/new 五步（gatewayWiring.archiveCurrentConversation）', () => {
  it('空闲：刹车先于归档（C1 回归）+ 旧对话留归档区 + 寻址排除 + 回执 + 闸释放', async () => {
    const { getOrCreateConversation, findConversationBySource, getConversation } = await import(
      '../../electron/main/conversations/store'
    );
    const { steeringQueue, steeringKey } = await import('../../electron/main/agent/steeringQueue');
    const conv = await getOrCreateConversation(agentId, { platform: 'feishu', chatId: 'oc_new_1' }, '远程会话');

    const { adapter, sent } = makeFakeAdapter();
    const gw = await makeGateway(adapter, []);
    await gw.handleMessage(newEvt('oc_new_1'));

    // 顺序：刹车先于归档——后台任务/播报不清完，它们写消息会解档复活旧对话
    expect(callOrder).toEqual(['brake', 'archive']);
    expect(vi.mocked(cancelTasksForConversation)).toHaveBeenCalledWith(conv.id);
    expect(vi.mocked(archiveConversation)).toHaveBeenCalledWith(agentId, conv.id);
    // 渠道寻址排除已归档：旧对话查不到（下条消息另起一段）；旧对话留在归档区（没删、带 archivedAt）
    expect(await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_new_1' })).toBeNull();
    expect((await getConversation(agentId, conv.id)).archivedAt).toBeTypeOf('number');
    expect(sent.at(-1)!.content).toContain('已开新篇');
    expect(steeringQueue.isRunning(steeringKey(agentId, conv.id))).toBe(false);
  });

  it('忙（闸被占）→ 拒绝回执提示先 /stop，不归档、不刹车', async () => {
    const { getOrCreateConversation, getConversation } = await import('../../electron/main/conversations/store');
    const { steeringQueue, steeringKey } = await import('../../electron/main/agent/steeringQueue');
    const conv = await getOrCreateConversation(agentId, { platform: 'feishu', chatId: 'oc_new_2' }, '远程会话二');
    const key = steeringKey(agentId, conv.id);
    const token = await steeringQueue.beginDirectTurn(key); // 模拟有回合在跑
    expect(token).not.toBeNull();

    const { adapter, sent } = makeFakeAdapter();
    const gw = await makeGateway(adapter, []);
    await gw.handleMessage(newEvt('oc_new_2'));

    expect(sent.at(-1)!.content).toContain('/stop');
    expect(sent.at(-1)!.content).not.toContain('已开新篇');
    expect((await getConversation(agentId, conv.id)).archivedAt ?? null).toBeNull();
    expect(callOrder).toEqual([]);
    await steeringQueue.handBackIfRunning(key, token!); // 收尾：释放模拟闸
  });

  it('释闸交还：占闸窗口期落进旧队列的零星项走 handback（不重投不丢弃）', async () => {
    const { getOrCreateConversation } = await import('../../electron/main/conversations/store');
    const { steeringQueue, steeringKey } = await import('../../electron/main/agent/steeringQueue');
    const conv = await getOrCreateConversation(agentId, { platform: 'feishu', chatId: 'oc_new_3' }, '远程会话三');
    const key = steeringKey(agentId, conv.id);

    // 在 brake 被调（闸已占住）到归档完成之间的窗口期，从另一源落一条消息进旧队列
    vi.mocked(abortConversation).mockImplementationOnce(() => {
      callOrder.push('brake');
      void steeringQueue.enqueueOrStart(key, { clientMsgId: 'm-window', text: '窗口期来的消息', trigger: 'user' });
      return true;
    });

    const { adapter } = makeFakeAdapter();
    const events: ServerEvent[] = [];
    const gw = await makeGateway(adapter, events);
    await gw.handleMessage(newEvt('oc_new_3'));

    const handback = events.find((e) => e.type === 'chat.queue.handback');
    expect(handback).toBeDefined();
    expect(handback && handback.type === 'chat.queue.handback' ? handback.items.map((i) => i.text) : []).toEqual([
      '窗口期来的消息',
    ]);
    expect(steeringQueue.isRunning(key)).toBe(false);
  });

  it('无绑定会话 → 回执「还没有会话」，不动手', async () => {
    const orphanSrc: SessionSource = { ...src, chatId: 'oc_nobody' };
    const { adapter, sent } = makeFakeAdapter();
    const gw = await makeGateway(adapter, []);
    await gw.handleMessage({ ...newEvt('oc_nobody'), source: orphanSrc });
    expect(sent.at(-1)!.content).toContain('还没有');
    expect(callOrder).toEqual([]);
  });
});
