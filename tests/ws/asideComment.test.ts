/**
 * aside.comment 短评管线（runAsideComment）：
 * - prompt 含 referent 的文本与上下文；五种 referent type 的点击位置措辞各走各的分支
 * - systemContext = 人格 + 记忆快照 + 评点规则（三段特征句逐一断言）
 * - vision 模型带 images / 非 vision 模型不带；asideComment 未分配回落 twinMain 的口径
 * - 失败/超时一律静默：resolves null，不向 router 外抛
 *
 * backend 经 __setBackendFactoryForTest 替换（compress.test.ts 同模式）；
 * getAgent / buildSnapshot / getSettings 用 vi.mock，satisfies 真模块导出签名（项目约定）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '@shared/types';
import type { AgentBackend, OneShotInput, OneShotResult } from '@shared/agent/backend';

vi.mock('../../electron/main/agent/store/agents', () => ({
  getAgent: async (id: string) => ({
    id,
    ownerId: 'owner-1',
    name: 'Oru',
    homePath: '/tmp/oru-home',
    systemPromptAppend: '人格特征句：毒舌但温柔',
    approvalMode: 'work',
    createdAt: 0,
    avatarPath: null,
  }),
}) satisfies Pick<typeof import('../../electron/main/agent/store/agents'), 'getAgent'>);

vi.mock('../../electron/main/memory/snapshot', () => ({
  buildSnapshot: async () => '记忆快照特征句：最近在做随手评点',
}) satisfies Pick<typeof import('../../electron/main/memory/snapshot'), 'buildSnapshot'>);

vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

import { getSettings } from '../../electron/main/projects/store';
import { __setBackendFactoryForTest } from '../../electron/main/agent/backends/factory';
import {
  ASIDE_COMMENT_RULES,
  buildAsideCommentPrompt,
  runAsideComment,
} from '../../electron/main/ws/aside/comment';

// ─── fixtures ────────────────────────────────────────────────

function makeSettings(p: {
  asideComment?: string | null;
  twinMain?: string | null;
  models?: Array<{ id: string; supportsVision: boolean }>;
  asideThinking?: boolean;
}): Settings {
  return {
    theme: 'system',
    colorScheme: 'terracotta',
    manualApiKey: null,
    asideThinking: p.asideThinking,
    providers: [],
    models: (p.models ?? []).map((m) => ({
      id: m.id,
      providerId: 'prov-1',
      modelId: m.id,
      label: m.id,
      supportsVision: m.supportsVision,
    })),
    modelAssignments: {
      twinMain: p.twinMain ?? null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: null,
      conversationSummary: null,
      conversationTitle: null,
      twinSubagent: null,
      asideComment: p.asideComment ?? null,
    },
  };
}

/** 捕获 runOneShot 入参的 mock backend；impl 可注入失败/挂起行为 */
function makeBackend(
  impl?: (input: OneShotInput, signal?: AbortSignal) => Promise<OneShotResult>,
): { backend: AgentBackend; calls: OneShotInput[] } {
  const calls: OneShotInput[] = [];
  const backend = {
    backendType: 'anthropic',
    toolProtocol: 'anthropic-native',
    runConversation: () => {
      throw new Error('not used');
    },
    runOneShot: async (input: OneShotInput, signal?: AbortSignal) => {
      calls.push(input);
      return impl ? impl(input, signal) : { text: '一句短评' };
    },
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  } satisfies AgentBackend;
  return { backend, calls };
}

const restores: Array<() => void> = [];
function useBackend(b: AgentBackend): void {
  restores.push(__setBackendFactoryForTest(async () => b));
}
afterEach(() => {
  while (restores.length) restores.pop()!();
  vi.useRealTimers();
});

/** 默认：asideComment 配了 vision 模型 */
function useVisionSettings(): void {
  vi.mocked(getSettings).mockResolvedValue(
    makeSettings({
      asideComment: 'model-v',
      models: [{ id: 'model-v', supportsVision: true }],
    }),
  );
}

const MESSAGE_REFERENT = {
  type: 'message',
  label: '一条消息',
  messageId: 'msg-1',
  text: '这页的配色有点闷',
  context: '上一条：配色草稿；下一条：好的我调亮',
} as const;

// ─── prompt 组装 ─────────────────────────────────────────────

describe('buildAsideCommentPrompt：referent 各 type 的措辞与字段', () => {
  it('selection：选中措辞 + text + surround', () => {
    const p = buildAsideCommentPrompt({
      type: 'selection',
      label: '选中文字',
      text: '第一性原则',
      surround: '……从第一性原则重新推导……',
    });
    expect(p).toContain('选中的一段文字');
    expect(p).toContain('第一性原则');
    expect(p).toContain('所在上下文：……从第一性原则重新推导……');
  });

  it('selection：无 surround 时不出现上下文行', () => {
    const p = buildAsideCommentPrompt({ type: 'selection', label: 'x', text: '只有选中' });
    expect(p).not.toContain('所在上下文');
  });

  it('message：消息措辞 + text + context', () => {
    const p = buildAsideCommentPrompt(MESSAGE_REFERENT);
    expect(p).toContain('对话里的一条消息');
    expect(p).toContain('这页的配色有点闷');
    expect(p).toContain('前后消息：上一条：配色草稿；下一条：好的我调亮');
  });

  it('deck-page：页码按人类口径 +1 + text + outline', () => {
    const p = buildAsideCommentPrompt({
      type: 'deck-page',
      label: '第 3 页',
      pageIndex: 2,
      text: '本页讲营收',
      outline: '1. 开场 2. 营收 3. 展望',
    });
    expect(p).toContain('第 3 页');
    expect(p).toContain('本页讲营收');
    expect(p).toContain('各页标题：1. 开场 2. 营收 3. 展望');
  });

  it('control：控件措辞 + caption；无 caption 时只有措辞', () => {
    const withCaption = buildAsideCommentPrompt({ type: 'control', label: '按钮', caption: '发送' });
    expect(withCaption).toContain('一个控件');
    expect(withCaption).toContain('控件可见文案：发送');
    const bare = buildAsideCommentPrompt({ type: 'control', label: '按钮' });
    expect(bare).toContain('一个控件');
    expect(bare).not.toContain('控件可见文案');
  });

  it('带 region 的 referent → prompt 含场所句（区域 id 翻译成人话）', () => {
    const p = buildAsideCommentPrompt({ ...MESSAGE_REFERENT, region: 'memory' });
    expect(p).toContain('用户点击的位置在【');
    expect(p).toContain('记忆');
  });

  it('无 region → 不出现场所句（不硬认）', () => {
    const p = buildAsideCommentPrompt(MESSAGE_REFERENT);
    expect(p).not.toContain('用户点击的位置在');
  });

  it('blank：空白措辞 + context；无 context 时只有措辞', () => {
    const withCtx = buildAsideCommentPrompt({ type: 'blank', label: '空白', context: '附近是输入框' });
    expect(withCtx).toContain('一处空白');
    expect(withCtx).toContain('附近内容：附近是输入框');
    const bare = buildAsideCommentPrompt({ type: 'blank', label: '空白' });
    expect(bare).not.toContain('附近内容');
  });

  it('screen（唤起对话窗外）：窗外措辞 + 焦点说明 + app 名（有/无）', () => {
    const withApp = buildAsideCommentPrompt({ type: 'screen', label: 'Figma', app: 'Figma' });
    expect(withApp).toContain('Oru 窗口之外');
    expect(withApp).toContain('他此刻在用的应用是：Figma');
    expect(withApp).toContain('焦点是他点的那一块'); // 焦点≠整屏泛泛话
    const bare = buildAsideCommentPrompt({ type: 'screen', label: '屏幕' });
    expect(bare).toContain('Oru 窗口之外');
    expect(bare).not.toContain('他此刻在用的应用是'); // app 缺席不硬认
  });
});

// ─── runAsideComment 主流程 ──────────────────────────────────

describe('runAsideComment', () => {
  it('prompt 含 referent 文本/上下文；systemContext 含人格 + 记忆快照 + 评点规则', async () => {
    useVisionSettings();
    const { backend, calls } = makeBackend();
    useBackend(backend);

    const text = await runAsideComment({
      type: 'aside.comment',
      agentId: 'agent-1',
      referent: MESSAGE_REFERENT,
    });
    expect(text).toBe('一句短评');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('这页的配色有点闷');
    expect(calls[0].prompt).toContain('上一条：配色草稿');
    const sys = calls[0].systemContext ?? '';
    expect(sys).toContain('人格特征句：毒舌但温柔');
    expect(sys).toContain('记忆快照特征句：最近在做随手评点');
    expect(sys).toContain(ASIDE_COMMENT_RULES);
    expect(sys).toContain('不超过 50 字');
  });

  it('软件自述（场所感通识层）在短评与短聊两条路径同口径注入', async () => {
    const { ORU_SOFTWARE_MAP } = await import('@shared/asideRegions');
    const { ASIDE_CHAT_RULES } = await import('../../electron/main/ws/aside/comment');
    // 自述特征句：记忆笔记页是 Oru 自己写的（评错对象的真机案例正是这里）
    expect(ORU_SOFTWARE_MAP).toContain('记忆');
    // 短聊路径：自述随 ASIDE_CHAT_RULES 进 extraStableSystemPrompt
    expect(ASIDE_CHAT_RULES).toContain(ORU_SOFTWARE_MAP);
    // 短评路径：自述随 ASIDE_COMMENT_RULES 进 systemContext
    expect(ASIDE_COMMENT_RULES).toContain(ORU_SOFTWARE_MAP);
  });

  it('vision 模型 + screenshot → images 带图（PNG）+ prompt 末尾追加截图锚点句', async () => {
    useVisionSettings();
    const { backend, calls } = makeBackend();
    useBackend(backend);

    await runAsideComment({
      type: 'aside.comment',
      agentId: 'agent-1',
      referent: MESSAGE_REFERENT,
      screenshot: 'UE5H',
    });
    expect(calls[0].images).toEqual([{ base64: 'UE5H', mediaType: 'image/png' }]);
    // 锚点句三要素：圈=点击区域；圈是标注非界面；禁词带正向替代（说「你点的这里」不说圈）
    expect(calls[0].prompt).toContain('圆圈圈出的是用户点击的区域');
    expect(calls[0].prompt).toContain('圆圈是给你的标注，不是界面的一部分');
    expect(calls[0].prompt).toContain('你点的这里');
    expect(calls[0].prompt).toContain('一个都不要出现');
  });

  it('非 vision 模型 + screenshot → 不带 images（仅文本上下文），prompt 不出现截图锚点句', async () => {
    vi.mocked(getSettings).mockResolvedValue(
      makeSettings({
        asideComment: 'model-nv',
        models: [{ id: 'model-nv', supportsVision: false }],
      }),
    );
    const { backend, calls } = makeBackend();
    useBackend(backend);

    await runAsideComment({
      type: 'aside.comment',
      agentId: 'agent-1',
      referent: MESSAGE_REFERENT,
      screenshot: 'UE5H',
    });
    expect(calls[0].images).toBeUndefined();
    expect(calls[0].prompt).not.toContain('截图');
  });

  it('asideComment 未分配 → vision 判定回落 twinMain 所配模型（factory 同口径）', async () => {
    vi.mocked(getSettings).mockResolvedValue(
      makeSettings({
        asideComment: null,
        twinMain: 'model-v',
        models: [{ id: 'model-v', supportsVision: true }],
      }),
    );
    const { backend, calls } = makeBackend();
    useBackend(backend);

    await runAsideComment({
      type: 'aside.comment',
      agentId: 'agent-1',
      referent: MESSAGE_REFERENT,
      screenshot: 'UE5H',
    });
    expect(calls[0].images).toEqual([{ base64: 'UE5H', mediaType: 'image/png' }]);
  });

  it('思考开关默认关（asideThinking 缺省）→ runOneShot 收到 disableReasoning: true', async () => {
    useVisionSettings();
    const { backend, calls } = makeBackend();
    useBackend(backend);

    await runAsideComment({ type: 'aside.comment', agentId: 'agent-1', referent: MESSAGE_REFERENT });
    expect(calls[0].disableReasoning).toBe(true);
  });

  it('asideThinking: true → 不关思考（disableReasoning 缺席）', async () => {
    vi.mocked(getSettings).mockResolvedValue(
      makeSettings({
        asideComment: 'model-v',
        models: [{ id: 'model-v', supportsVision: true }],
        asideThinking: true,
      }),
    );
    const { backend, calls } = makeBackend();
    useBackend(backend);

    await runAsideComment({ type: 'aside.comment', agentId: 'agent-1', referent: MESSAGE_REFERENT });
    expect(calls[0].disableReasoning).toBeUndefined();
  });

  it('backend 失败 → 静默 resolves null（不抛出）', async () => {
    useVisionSettings();
    const { backend } = makeBackend(async () => {
      throw new Error('provider 500');
    });
    useBackend(backend);

    await expect(
      runAsideComment({ type: 'aside.comment', agentId: 'agent-1', referent: MESSAGE_REFERENT }),
    ).resolves.toBeNull();
  });

  it('15s 超时 → abort 后静默 resolves null（不抛出）', async () => {
    vi.useFakeTimers();
    useVisionSettings();
    // 永不 resolve，只在 abort 信号到来时 reject——模拟挂死的上游
    const { backend } = makeBackend(
      (_input, signal) =>
        new Promise<OneShotResult>((_res, rej) => {
          signal?.addEventListener('abort', () => rej(new Error('aborted')), { once: true });
        }),
    );
    useBackend(backend);

    const p = runAsideComment({
      type: 'aside.comment',
      agentId: 'agent-1',
      referent: MESSAGE_REFERENT,
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(p).resolves.toBeNull();
  });
});
