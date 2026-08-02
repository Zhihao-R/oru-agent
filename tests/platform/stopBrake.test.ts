/**
 * 远程 /stop = 对话级刹车（G30）——gatewayWiring 接线回归
 *
 * 理想架构 subagent.html#PFail：桌面按停（chat.abort）已扩为对话级刹车（G17），远程渠道
 * 的 /stop 此前走 gatewayWiring 直调 abortConversation，只停当前轮、不刹后台。本测试钉住
 * 对齐后的行为：平台 /stop 经 gateway 的命令插队路径，触发与桌面同一份 brakeConversation——
 * 停当前轮 + 取消运行中任务（brakeCancelled 静默）+ 撤排队派工 + 杀后台 bash。
 *
 * 修复前红：只有 abortConversation 被调，三个后台撤销（cancelTasks / cancelQueued / killBash）
 * 全不触发。远程无输入框、入站走独立串行链（G10，不经 steeringQueue）——故无 steering 草稿
 * 可交还，brakeConversation 本就不含 UI 收尾，直接复用。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { PlatformAdapter } from '../../electron/main/platform/adapter';
import type { MessageEvent, SendResult, SessionSource } from '@shared/platform/message';

const ORU_DIR = join(tmpdir(), `oru-test-stop-brake-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

// ─── mock：只桩掉刹车的各件（内核语义已由 chatAbortBrake / subagentRunnerBrake 单测），
//     这里只验「远程 /stop 是否把这套刹车接上」——与桌面 chatAbortBrake 同款桩法 ────────────
vi.mock('../../electron/main/agent/runner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/agent/runner')>();
  return {
    ...actual,
    abortConversation: vi.fn(() => true) satisfies typeof actual.abortConversation,
  };
});

vi.mock('../../electron/main/tasks/subagentRunner', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/subagentRunner')>();
  return {
    ...actual,
    // 返回 [] → brakeConversation 的异步收尾 for 循环不进入，全程同步（/stop 走 void 触发也已跑完）
    cancelTasksForConversation: vi.fn(() => []) satisfies typeof actual.cancelTasksForConversation,
  };
});

vi.mock('../../electron/main/tasks/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/tasks/queue')>();
  return {
    ...actual,
    cancelQueuedForConversation: vi.fn(() => []) satisfies typeof actual.cancelQueuedForConversation,
  };
});

vi.mock('../../electron/main/proposals/executeBashProposal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../electron/main/proposals/executeBashProposal')>();
  return {
    ...actual,
    killBashForConversation: vi.fn(() => {}) satisfies typeof actual.killBashForConversation,
  };
});

import { abortConversation } from '../../electron/main/agent/runner';
import { cancelTasksForConversation } from '../../electron/main/tasks/subagentRunner';
import { cancelQueuedForConversation } from '../../electron/main/tasks/queue';
import { killBashForConversation } from '../../electron/main/proposals/executeBashProposal';

const src: SessionSource = {
  platform: 'feishu',
  chatId: 'oc_stop',
  chatType: 'dm',
  userId: 'ou_stop',
  userIdAlt: 'un_stop',
  raw: {},
};
const stopEvt = (): MessageEvent => ({
  text: '/stop',
  messageId: `m_${Math.random()}`,
  source: src,
  command: { kind: 'stop' },
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
let convId: string;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
  const { saveWhitelist, setRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
  await saveWhitelist(['un_stop']);
  await setRemoteAgentId(agentId);
  // /stop「只查不建」——先建好这条来源会话，findConversation 才有 convId 可刹
  const { getOrCreateConversation } = await import('../../electron/main/conversations/store');
  convId = (await getOrCreateConversation(agentId, { platform: 'feishu', chatId: 'oc_stop' }, '远程会话')).id;
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('远程 /stop = 对话级刹车（G30）', () => {
  it('/stop 触发完整刹车：停当前轮 + 取消任务 + 撤排队 + 杀后台 bash（都指向该会话）', async () => {
    vi.clearAllMocks();
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, saveWhitelist, resolveRemoteAgentId } = await import(
      '../../electron/main/platform/platformSettings'
    );
    const { adapter } = makeFakeAdapter();

    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      saveWhitelist,
      resolveRemoteAgentId,
    });

    await gw.handleMessage(stopEvt());

    // 停当前轮（既有行为）
    expect(vi.mocked(abortConversation)).toHaveBeenCalledWith(agentId, convId);
    // 三个后台撤销（此前 /stop 完全不做——修复前红）
    expect(vi.mocked(cancelTasksForConversation)).toHaveBeenCalledWith(convId);
    expect(vi.mocked(cancelQueuedForConversation)).toHaveBeenCalledWith(convId);
    expect(vi.mocked(killBashForConversation).mock.calls).toEqual([[convId]]);
  });

  it('/stop 回「已停止」回执（远程原本完全静默）——文案走 i18n 按渠道语言', async () => {
    vi.clearAllMocks();
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, saveWhitelist, resolveRemoteAgentId } = await import(
      '../../electron/main/platform/platformSettings'
    );
    const { t } = await import('../../electron/main/i18n/t');
    const { adapter, sent } = makeFakeAdapter();

    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      saveWhitelist,
      resolveRemoteAgentId,
    });

    await gw.handleMessage(stopEvt());

    // 恰一条回执，发到发话渠道，文案是 i18n 的 platform.stopped（zh 或 en 视 owner 语言而定）
    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe('oc_stop');
    expect([t('main:platform.stopped', 'zh'), t('main:platform.stopped', 'en')]).toContain(sent[0].content);
  });

  it('/stop 在会话尚不存在时仍是 no-op（只查不建，不误刹别的会话）', async () => {
    vi.clearAllMocks();
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, saveWhitelist, resolveRemoteAgentId } = await import(
      '../../electron/main/platform/platformSettings'
    );
    const { adapter } = makeFakeAdapter();

    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      saveWhitelist,
      resolveRemoteAgentId,
    });

    await gw.handleMessage({
      text: '/stop',
      messageId: 'm_never',
      source: { platform: 'feishu', chatId: 'oc_never_seen', chatType: 'dm', userId: 'ou_stop', userIdAlt: 'un_stop', raw: {} },
      command: { kind: 'stop' },
    });

    expect(vi.mocked(abortConversation)).not.toHaveBeenCalled();
    expect(vi.mocked(cancelTasksForConversation)).not.toHaveBeenCalled();
    expect(vi.mocked(killBashForConversation)).not.toHaveBeenCalled();
  });
});
