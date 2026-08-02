/**
 * 入站→出站端到端集成（tech design §9，里程碑「adapter 收发跑通」的最高保真自动验证——
 * 真机靠真凭证，这里用假 adapter + 桩 backend 把除「真 LLM / 真平台传输」外的整条线全跑真的）：
 *
 *   白名单消息入站 → gateway 去重/access → getOrCreateConversation → gatewayWiring 真实 runTurn
 *   → appendMessage(user) → runChatAndPersist → runChat → 桩 backend 出文本 → onAssistantPersisted
 *   → redactSecrets → adapter.send 分段回发
 *
 * 顺带验红线 1：回发前脱敏（桩 backend 故意吐含 token 的文本，断言回发已抹）。
 * 模板沿用 tests/agent/runnerAsideBackend.test.ts（ORU_DIR + mock auth + __setBackendFactoryForTest）。
 */
import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';
import type { PlatformAdapter } from '../../electron/main/platform/adapter';
import type { MessageEvent, SendResult, SessionSource } from '@shared/platform/message';

const ORU_DIR = join(tmpdir(), `oru-test-inout-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

import { vi } from 'vitest';
vi.mock('../../electron/main/agent/auth', () => ({
  detectAuth: async () => ({ mode: 'claude_cli' as const, ready: true, hint: 'mock' }),
  resolveApiKeyForSdk: async () => undefined,
}) satisfies Pick<typeof import('../../electron/main/agent/auth'), 'detectAuth' | 'resolveApiKeyForSdk'>);

// 视觉判定可控（默认支持；「模型不支持看图」用例内翻 false）——沙箱 settings 走 OAuth fallback 恒 true，
// 不 mock 就物理触发不了该分支。
let visionOk = true;
vi.mock('../../electron/main/agent/backends/visionSupport', () => ({
  currentTwinSupportsVision: async () => visionOk,
}) satisfies typeof import('../../electron/main/agent/backends/visionSupport'));

// 记忆抽取现由 runChatAndPersist 落 assistant 那刻从历史数轮次驱动——不再桩 captureScheduler，
// 而是让真实调度器跑、桩掉底层 runCapture，据此验「入站攒够阈值即触发抽取」的真行为（①根治的回归）。
const { runCaptureSpy } = vi.hoisted(() => ({
  runCaptureSpy: vi.fn<(typeof import('../../electron/main/memory/capture'))['runCapture']>(),
}));
vi.mock('../../electron/main/memory/capture', () => ({
  runCapture: runCaptureSpy,
}) satisfies Pick<typeof import('../../electron/main/memory/capture'), 'runCapture'>);

/** 桩 backend：吐一段含假 token 的文本，验证回发脱敏；顺带捕获 ConversationInput 供断言。 */
const CANNED_REPLY = '已建好文档，token=t-abcdef12345678 仅供调试';
const seenInputs: ConversationInput[] = [];
function makeBackend(): AgentBackend {
  return {
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
    runConversation: (input: ConversationInput) => {
      seenInputs.push(input);
      return {
        events: (async function* () {
          yield { type: 'result' as const, resultText: CANNED_REPLY, isError: false };
        })(),
      };
    },
    runOneShot: async () => ({ text: 'unused' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  } satisfies AgentBackend;
}

import { registerChannelSender, unregisterChannelSender } from '../../electron/main/platform/outbound';

/**
 * S10：回发经 outbound.ts 的注册发送器（生产由 platformManager 连接时注册）。本集成测试直连
 * createPlatformGateway、不走 platformManager，故手动注册这个假 adapter 的 send 作出站发送器。
 */
function wireOutbound(adapter: PlatformAdapter): void {
  registerChannelSender(adapter.platform, (chatId, text) => adapter.send(chatId, text));
}

/** 假飞书 adapter：只捕获 send，connect/disconnect noop；fetchImage 可注入（入站图懒拉取）。 */
function makeFakeAdapter(fetchImage?: (messageId: string, key: string) => Promise<Buffer>) {
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
    ...(fetchImage ? { fetchImage } : {}),
  };
  return { adapter, sent };
}

/** 一段带 PNG magic bytes 的假图字节（saveAttachments 只验 magic + 大小，不解码像素）。 */
const FAKE_PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 1),
]);

const src: SessionSource = { platform: 'feishu', chatId: 'oc_int', chatType: 'dm', userId: 'ou_int', userIdAlt: 'un_int', raw: {} };
const evt = (text: string, over: Partial<MessageEvent> = {}): MessageEvent => ({
  text,
  messageId: `m_${Math.random()}`,
  source: src,
  ...over,
});

let agentId: string;
let restoreFactory: () => void;

beforeAll(async () => {
  // 抽取真调度器会跑（读历史数轮次）——桩 runCapture 恒成功且游标跳到最大，避免死循环/重复触发
  runCaptureSpy.mockResolvedValue({ kind: 'ok', opsApplied: 0, opsFailed: 0, coveredUntil: Number.MAX_SAFE_INTEGER });
  await fs.mkdir(ORU_DIR, { recursive: true });
  const { setTasksGateway } = await import('../../electron/main/agent/tasksGateway');
  const { listTasksForConversation, markAnnounced, getLastProgress, getQuestions } = await import('../../electron/main/tasks/store');
  setTasksGateway({ listTasksForConversation, markAnnounced, getLastProgress, getQuestions });
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
  const { __setBackendFactoryForTest } = await import('../../electron/main/agent/backends/factory');
  restoreFactory = __setBackendFactoryForTest(async () => makeBackend());
  // 设置：白名单放行该发送者 + 远程默认 agent 指向它
  const { saveWhitelist, setRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
  await saveWhitelist([{ id: 'un_int' }]);
  await setRemoteAgentId(agentId);
  // owner 语言定死 zh——回执文案断言不依赖测试机 locale
  const { updateSettings } = await import('../../electron/main/projects/store');
  await updateSettings({ language: 'zh' });
});

afterEach(async () => {
  unregisterChannelSender('feishu'); // 出站发送器随测试生灭，别串到下一个用例
  // 所有用例共享 oc_int 对话 + steeringQueue 单例；回合已改 fire-and-forget（void runAssembledMainTurn），
  // 等本对话的准入闸释放，否则上一回合没跑完时下一用例 admit 会被判「忙」而入队、起不了回合。
  const { findConversationBySource } = await import('../../electron/main/conversations/store');
  const { steeringQueue, steeringKey } = await import('../../electron/main/agent/steeringQueue');
  const conv = await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_int' });
  if (conv) await vi.waitFor(() => expect(steeringQueue.isRunning(steeringKey(agentId, conv.id))).toBe(false));
});

afterAll(async () => {
  restoreFactory();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('入站→出站端到端', () => {
  it('白名单消息跑通整条线：回发到平台 + 落盘 user/assistant + 回发脱敏', async () => {
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const { fake, sent } = (() => {
      const f = makeFakeAdapter();
      return { fake: f.adapter, sent: f.sent };
    })();

    const gw = createPlatformGateway(fake, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      addToWhitelist,
      resolveRemoteAgentId,
    });
    wireOutbound(fake);

    await gw.handleMessage(evt('把刚才聊的整理成飞书文档'));
    // 统一准入后回合是 fire-and-forget（void runAssembledMainTurn）——等回发落定
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(1));

    // 1. 回发到了平台（同一 chatId）
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(sent[0].chatId).toBe('oc_int');
    const reply = sent.map((s) => s.content).join('');
    // 2. 回发内容是 backend 的产物
    expect(reply).toContain('已建好文档');
    // 3. 红线 1：回发前脱敏——假 token 不出现在发往平台的内容里
    expect(reply).not.toContain('t-abcdef12345678');

    // 4. 落盘：该来源的会话里有 user + assistant 两条
    const { findConversationBySource } = await import('../../electron/main/conversations/store');
    const conv = await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_int' });
    expect(conv).not.toBeNull();
    const { readHistory } = await import('../../electron/main/conversations/store');
    const history = await readHistory(agentId, conv!.id);
    expect(history.some((m) => m.role === 'user' && m.text === '把刚才聊的整理成飞书文档')).toBe(true);
    expect(history.some((m) => m.role === 'assistant')).toBe(true);
  });

  // §4.5：平台 turn 必须通知「该 agent 的会话变了」，否则新会话 / 冒顶不会进桌面列表
  // （conv.state 驱动列表，平台 turn 此前全程不广播——这是修复的 bug 本身）。
  it('平台 turn 后通知会话变更（桌面列表实时同步的信号）', async () => {
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const { adapter } = makeFakeAdapter();

    const changed: string[] = [];
    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      addToWhitelist,
      resolveRemoteAgentId,
      notifyConvChanged: (id) => changed.push(id),
    });

    await gw.handleMessage(evt('随便聊一句'));

    // user 消息落盘（updatedAt 刷新）后即通知，让桌面列表当场冒出 / 重排这条会话
    expect(changed).toContain(agentId);
  });

  // 修复「桌面插话后飞书新消息在桌面消失」：平台 turn 必须把 chat.* 广播给桌面（此前 emit noop），
  // 否则桌面打开着的同一对话收不到飞书产生的消息。
  it('平台 turn 把 chat.* 广播给桌面（入站 user + chat.started + chat.done）', async () => {
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const { findConversationBySource } = await import('../../electron/main/conversations/store');
    const { adapter } = makeFakeAdapter();

    const events: import('@shared/protocol').ServerEvent[] = [];
    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      addToWhitelist,
      resolveRemoteAgentId,
      broadcast: (ev) => events.push(ev),
    });
    wireOutbound(adapter);

    await gw.handleMessage(evt('桌面这边能看到吗'));
    // 回合 fire-and-forget——等 chat.done 落定再断言事件序
    await vi.waitFor(() => expect(events.some((e) => e.type === 'chat.done')).toBe(true));

    const conv = await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_int' });
    const convId = conv!.id;

    // 入站 user 消息广播（桌面据此显示「对方在飞书发了什么」），convId / 文本正确
    const inbound = events.find((e) => e.type === 'chat.inboundUserMessage');
    expect(inbound).toBeTruthy();
    expect((inbound as Extract<typeof inbound, { type: 'chat.inboundUserMessage' }>).conversationId).toBe(convId);
    expect((inbound as Extract<typeof inbound, { type: 'chat.inboundUserMessage' }>).message.role).toBe('user');
    expect((inbound as Extract<typeof inbound, { type: 'chat.inboundUserMessage' }>).message.text).toBe('桌面这边能看到吗');

    // 起回合占位 + 回合结束，均带同一 convId
    const started = events.find((e) => e.type === 'chat.started');
    const done = events.find((e) => e.type === 'chat.done');
    expect(started).toBeTruthy();
    expect(done).toBeTruthy();
    expect((started as Extract<typeof started, { type: 'chat.started' }>).conversationId).toBe(convId);

    // chat.started 的 messageId 必须等于 chat.done 的 messageId（占位与流式同一条 assistant）
    const startedMid = (started as Extract<typeof started, { type: 'chat.started' }>).messageId;
    const doneMid = (done as Extract<typeof done, { type: 'chat.done' }>).messageId;
    expect(startedMid).toBe(doneMid);

    // 顺序：入站 user 先于 chat.started（桌面先看到对方消息、再看到回复占位）
    expect(events.findIndex((e) => e.type === 'chat.inboundUserMessage')).toBeLessThan(
      events.findIndex((e) => e.type === 'chat.started'),
    );
  });

  // 入站图（懒拉取）：imageKeys → runTurn 内 fetchImage → saveAttachments 落盘 → 挂 user 消息 →
  // history 重读后被 backend 看到（进模型的通路）。飞书单发图片 text 为空——正是原 400 bug 场景。
  it('纯图消息跑通：下载落盘、附件挂 user 消息、backend 在 history 里看到它', async () => {
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const fetched: Array<{ messageId: string; key: string }> = [];
    const { adapter, sent } = makeFakeAdapter(async (messageId, key) => {
      fetched.push({ messageId, key });
      return FAKE_PNG;
    });

    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      addToWhitelist,
      resolveRemoteAgentId,
    });
    wireOutbound(adapter);

    seenInputs.length = 0;
    await gw.handleMessage(evt('', { messageId: 'om_img_1', imageKeys: ['img_k1'] }));
    await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(1));

    // 懒拉取用消息坐标下载
    expect(fetched).toEqual([{ messageId: 'om_img_1', key: 'img_k1' }]);
    // 回合正常跑完（原 bug：空文本消息 400 中断、无回复）
    expect(sent.map((s) => s.content).join('')).toContain('已建好文档');
    // 附件挂在落盘的 user 消息上（进模型的唯一通路）
    const { findConversationBySource, readHistory } = await import('../../electron/main/conversations/store');
    const conv = await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_int' });
    const history = await readHistory(agentId, conv!.id);
    const imgMsg = history.find((m) => m.role === 'user' && (m.attachments?.length ?? 0) > 0);
    expect(imgMsg).toBeDefined();
    expect(imgMsg!.attachments![0].mediaType).toBe('image/png');
    // backend 收到的 history 末条 user 消息带附件（claudeCode/anthropic 两路的消费前提）
    const lastInput = seenInputs[seenInputs.length - 1];
    const lastUser = [...(lastInput.history ?? [])].reverse().find((m) => m.role === 'user');
    expect(lastUser?.attachments?.length).toBe(1);
    // 落盘的附件字节真实存在
    const { readAttachmentBase64 } = await import('../../electron/main/conversations/attachments');
    const b64 = await readAttachmentBase64(agentId, conv!.id, imgMsg!.attachments![0]);
    expect(Buffer.from(b64, 'base64').equals(FAKE_PNG)).toBe(true);
  });

  it('图片下载失败 → 如实回「图片」失败回执、不落 user 消息、不起回合', async () => {
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const { adapter, sent } = makeFakeAdapter(async () => {
      throw new Error('403 no permission');
    });

    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      addToWhitelist,
      resolveRemoteAgentId,
    });

    const { findConversationBySource, readHistory } = await import('../../electron/main/conversations/store');
    const before = await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_int' });
    const beforeLen = before ? (await readHistory(agentId, before.id)).length : 0;

    seenInputs.length = 0;
    await gw.handleMessage(evt('', { messageId: 'om_img_2', imageKeys: ['img_k2'] }));

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain('图片');
    expect(seenInputs).toHaveLength(0); // 不起回合
    const after = await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_int' });
    const afterLen = after ? (await readHistory(agentId, after.id)).length : 0;
    expect(afterLen).toBe(beforeLen); // 没落半条 user 消息
  });

  it('模型不支持看图 → 如实回执，不下载、不落消息、不起回合', async () => {
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const fetched: string[] = [];
    const { adapter, sent } = makeFakeAdapter(async (_mid, key) => {
      fetched.push(key);
      return FAKE_PNG;
    });

    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      addToWhitelist,
      resolveRemoteAgentId,
    });

    seenInputs.length = 0;
    visionOk = false;
    try {
      await gw.handleMessage(evt('', { messageId: 'om_img_3', imageKeys: ['img_k3'] }));
    } finally {
      visionOk = true;
    }

    expect(fetched).toHaveLength(0); // 视觉检查在下载之前——不为注定白费的图发生 IO
    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain('不支持看图');
    expect(seenInputs).toHaveLength(0);
  });

  // S05 · G08「投递失败上层有感知」：onAssistantPersisted 此前不检查 adapter.send 结果，
  // 投递失败静默吞掉（用户在平台端等不到回复、日志也无痕）。最小感知=检查 + 留日志。
  it('回发投递失败 → 上层检查结果并留 warn 日志（不再静默）', async () => {
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const adapter: PlatformAdapter = {
      platform: 'feishu',
      maxMessageLength: 8000,
      maxFileBytes: 1024,
      connect: async () => true,
      disconnect: async () => {},
      send: async (): Promise<SendResult> => ({ ok: false, error: 'ETIMEDOUT', failure: 'unknown' }),
    };

    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      addToWhitelist,
      resolveRemoteAgentId,
    });
    wireOutbound(adapter);

    const warnSpy = vi.spyOn(console, 'warn');
    try {
      await gw.handleMessage(evt('这条回复会投递失败'));
      // 回合 fire-and-forget——等回发失败的 warn 落定（outbound.deliverToChannel 留痕）
      await vi.waitFor(() =>
        expect(warnSpy.mock.calls.some((args) => args.join(' ').includes('投递失败'))).toBe(true),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('非文本非图消息（贴纸/文件等 normalize 后两空）→ 「不支持」回执、不进 agent', async () => {
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const { adapter, sent } = makeFakeAdapter();

    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      addToWhitelist,
      resolveRemoteAgentId,
    });

    seenInputs.length = 0;
    await gw.handleMessage(evt(''));

    expect(sent).toHaveLength(1);
    expect(sent[0].content).toContain('文字和图片');
    expect(seenInputs).toHaveLength(0);
  });

  // 回归：入站用户消息必须被记忆抽取计入轮次（与桌面 chat.ts 路径对齐）。
  // 旧 bug：S10 统一准入把 assistant 侧触发迁进 runChatAndPersist，user 侧手抄计数漏迁——
  // 飞书/Discord 对话 turns 永远为 0，凑不够阈值，episode 从不被抽取。本次重构把计数改为
  // 触发时从历史数轮次，入站经 admit → 回合循环 → runChatAndPersist 天然覆盖，① 根治。
  // dream 无需在此断言：它由 capture 写出 episode 后经 onEpisodeWritten 接续，随 capture 修好而恢复。
  it('入站攒够阈值即触发记忆抽取（① 漏计根治的回归）', async () => {
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const { findConversationBySource } = await import('../../electron/main/conversations/store');
    const { steeringQueue, steeringKey } = await import('../../electron/main/agent/steeringQueue');
    const { adapter } = makeFakeAdapter();

    const gw = createPlatformGateway(adapter, {
      pairing: new PairingManager({ now: () => Date.now() }),
      loadWhitelist,
      addToWhitelist,
      resolveRemoteAgentId,
    });
    wireOutbound(adapter);

    runCaptureSpy.mockClear();
    // 独立对话：历史与游标不受其它用例污染，凑齐 TURN_THRESHOLD(3) 条真实用户消息即触发
    const capSrc: SessionSource = { ...src, chatId: 'oc_cap' };
    for (const text of ['记一笔①', '再记一笔②', '第三笔③']) {
      await gw.handleMessage(evt(text, { source: capSrc }));
      const conv = await vi.waitFor(async () => {
        const cc = await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_cap' });
        expect(cc).toBeTruthy();
        return cc!;
      });
      await vi.waitFor(() => expect(steeringQueue.isRunning(steeringKey(agentId, conv.id))).toBe(false));
    }

    const conv = await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_cap' });
    // 落 assistant 那刻从历史数轮次：满 3 条真实用户消息 → 触发抽取，游标从 0 起
    // （第 4 参 projectId：平台会话无活跃项目，恒 null——3b612885 起触发瞬间定住归属）
    await vi.waitFor(() => expect(runCaptureSpy).toHaveBeenCalledWith(expect.any(String), conv!.id, 0, null));
  });

  // 回归②：Oru 忙时连发的消息入队、回合末 persistConsumed 逐条落盘（mainTurnAssembly），
  // 这些排队消息也计入抽取轮次——旧实现只在 admit 起回合那条手抄 +1，排队消息不计数、永凑不够阈值。
  // 新实现从历史数轮次，排队消息落进历史即被数到，才凑得够 3 条触发（去掉排队两条就只 1 条真实用户）。
  it('排队消息（忙时连发→入队→回合末落盘）也计入抽取轮次（钉死 ② 修复）', async () => {
    const { __setBackendFactoryForTest } = await import('../../electron/main/agent/backends/factory');
    const { createPlatformGateway } = await import('../../electron/main/platform/gatewayWiring');
    const { PairingManager } = await import('../../electron/main/platform/pairing');
    const { loadWhitelist, addToWhitelist, resolveRemoteAgentId } = await import('../../electron/main/platform/platformSettings');
    const { findConversationBySource } = await import('../../electron/main/conversations/store');
    const { steeringQueue, steeringKey } = await import('../../electron/main/agent/steeringQueue');

    // 可控闸：首回合 backend 卡住，撑出「忙」窗口好让后两条入队；续跑回合不阻塞
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let gated = true;
    const restore = __setBackendFactoryForTest(async () => ({
      ...makeBackend(),
      runConversation: (input: ConversationInput) => {
        seenInputs.push(input);
        const blockThis = gated;
        return {
          events: (async function* () {
            if (blockThis) await gate;
            yield { type: 'result' as const, resultText: CANNED_REPLY, isError: false };
          })(),
        };
      },
    } satisfies AgentBackend));

    try {
      const { adapter } = makeFakeAdapter();
      const gw = createPlatformGateway(adapter, {
        pairing: new PairingManager({ now: () => Date.now() }),
        loadWhitelist,
        addToWhitelist,
        resolveRemoteAgentId,
      });
      wireOutbound(adapter);
      runCaptureSpy.mockClear();

      const qSrc: SessionSource = { ...src, chatId: 'oc_queue' };
      await gw.handleMessage(evt('忙时第一条', { source: qSrc })); // 起回合，backend 卡在 gate
      const conv = await vi.waitFor(async () => {
        const cc = await findConversationBySource(agentId, { platform: 'feishu', chatId: 'oc_queue' });
        expect(cc).toBeTruthy();
        return cc!;
      });
      await vi.waitFor(() => expect(steeringQueue.isRunning(steeringKey(agentId, conv.id))).toBe(true)); // 确认在忙

      gated = false; // 续跑回合不再阻塞
      await gw.handleMessage(evt('排队第二条', { source: qSrc })); // 忙 → 入队
      await gw.handleMessage(evt('排队第三条', { source: qSrc })); // 忙 → 入队
      release(); // 放行首回合 → 回合末 persistConsumed 落盘排队两条 → 续跑落 assistant → 数轮次

      // 三条真实用户消息（1 起回合 + 2 排队）落进历史 → 满阈值触发抽取（②：排队消息计入才够）
      await vi.waitFor(() => expect(runCaptureSpy).toHaveBeenCalledWith(expect.any(String), conv.id, 0, null));
      await vi.waitFor(() => expect(steeringQueue.isRunning(steeringKey(agentId, conv.id))).toBe(false));
    } finally {
      restore();
    }
  });
});
