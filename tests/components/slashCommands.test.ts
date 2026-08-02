/**
 * 桌面斜杠命令调度层（slashCommands.ts）——命中拦截不进 send（shouldInterceptCommand 钉子）、
 * 各命令调到正确的注入依赖、面板内容三态正确、/status 不吞。
 * store/ws 全经 SlashDeps 注入 fake，t 注入 key 回声（断言到 key 即断言到 i18n 接线）。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { TFunction } from 'i18next';
import type { PlatformCommand } from '@shared/platform/message';
import type { ConvCompressResultEvent } from '@shared/protocol';
import type { Conversation, RegisteredModel } from '@shared/types';
import { parseCommand } from '@shared/platform/command';
import {
  runSlashCommand,
  shouldInterceptCommand,
  type SlashDeps,
} from '@/components/chat/slashCommands';

const CTX = { agentId: 'a1', convId: 'c1' };

/** key 回声 t：断言到 key 即断言到 i18n 接线（文案本体由 locales + 快照测试管）。 */
const t = ((key: string, params?: Record<string, unknown>) =>
  params ? `${key} ${JSON.stringify(params)}` : key) as unknown as TFunction;

const MODELS: RegisteredModel[] = [
  { id: 'm1', providerId: 'p1', modelId: 'claude-sonnet', label: 'Claude Sonnet' },
  { id: 'm2', providerId: 'p2', modelId: 'gpt-5', label: 'GPT-5' },
];

const CREATED_CONV: Conversation = {
  id: 'c-new',
  ownerId: 'local-user',
  agentId: CTX.agentId,
  kind: 'sub',
  title: '新对话',
  sdkSessionId: null,
  createdAt: 0,
  updatedAt: 0,
};

function makeDeps(over: Partial<SlashDeps> = {}) {
  const deps: SlashDeps = {
    createConversation: vi.fn(async () => CREATED_CONV),
    setActive: vi.fn(),
    abort: vi.fn(async () => {}),
    updateAgent: vi.fn(async () => {}),
    listModels: vi.fn(async () => MODELS),
    getTwinMain: vi.fn(async () => 'm1'),
    setMainModel: vi.fn(async () => {}),
    compress: vi.fn(
      async (): Promise<ConvCompressResultEvent> => ({
        type: 'conv.compress.result',
        agentId: CTX.agentId,
        conversationId: CTX.convId,
        status: 'compressed',
        fallback: false,
      }),
    ),
    agentInfo: vi.fn(() => ({ name: '小欧', approvalMode: 'work' as const })),
    isBusy: vi.fn(() => false),
    queuedCount: vi.fn(() => 0),
    ...over,
  };
  return deps;
}

const run = (cmd: PlatformCommand, deps: SlashDeps) => runSlashCommand(cmd, CTX, deps, t);

beforeEach(() => vi.clearAllMocks());

describe('shouldInterceptCommand（ChatArea.onSend 拦截边界，plan §4 拍板行为）', () => {
  it('命中命令 → 拦截（不进 send）', () => {
    expect(shouldInterceptCommand(parseCommand('/new'), false)).toBe(true);
    expect(shouldInterceptCommand(parseCommand('/compress'), false)).toBe(true);
  });

  it('未知斜杠词 → 放行（/foo 不被吃掉，原样当普通消息）', () => {
    expect(shouldInterceptCommand(parseCommand('/foo'), false)).toBe(false);
    expect(shouldInterceptCommand(parseCommand('普通消息'), false)).toBe(false);
  });

  it('/status 同样拦截（PM 2026-08-01 拍板两端同体验）', () => {
    expect(shouldInterceptCommand(parseCommand('/status'), false)).toBe(true);
  });

  it('带附件 → 不拦截（命令带附件语义不明，克制不猜）', () => {
    expect(shouldInterceptCommand(parseCommand('/new'), true)).toBe(false);
    expect(shouldInterceptCommand(parseCommand('/compress'), true)).toBe(false);
  });
});

describe('runSlashCommand', () => {
  it('/new → conv.create + setActive（同新建按钮语义），无面板（UI 反射即反馈）', async () => {
    const deps = makeDeps();
    const panel = await run({ kind: 'new' }, deps);
    expect(deps.createConversation).toHaveBeenCalledWith('a1', expect.any(String));
    expect(deps.setActive).toHaveBeenCalledWith('a1', 'c-new');
    expect(panel).toBeNull();
  });

  it('/new 建对话失败 → 反馈面板（不静默无反应）', async () => {
    const deps = makeDeps({ createConversation: vi.fn(async () => null) });
    const panel = await run({ kind: 'new' }, deps);
    expect(deps.setActive).not.toHaveBeenCalled();
    expect(panel).toEqual({ kind: 'message', text: 'slash.failed' });
  });

  it('/stop → abort 当前对话，无面板', async () => {
    const deps = makeDeps();
    const panel = await run({ kind: 'stop' }, deps);
    expect(deps.abort).toHaveBeenCalledWith('c1');
    expect(panel).toBeNull();
  });

  it('/mode 合法挡位 → updateAgent + 反馈面板', async () => {
    const deps = makeDeps();
    const panel = await run({ kind: 'setMode', mode: 'danger' }, deps);
    expect(deps.updateAgent).toHaveBeenCalledWith('a1', { approvalMode: 'danger' });
    expect(panel).toEqual({ kind: 'message', text: expect.stringContaining('slash.modeSwitched') });
  });

  it('/mode 非法参数 → 用法面板，不动挡位', async () => {
    const deps = makeDeps();
    const panel = await run({ kind: 'setMode', mode: null }, deps);
    expect(deps.updateAgent).not.toHaveBeenCalled();
    expect(panel).toEqual({ kind: 'message', text: 'slash.modeUsage' });
  });

  it('/model 无参 → 模型清单面板（标注当前）', async () => {
    const deps = makeDeps();
    const panel = await run({ kind: 'model', index: null, invalid: false }, deps);
    expect(panel).toEqual({
      kind: 'models',
      models: [
        { label: 'Claude Sonnet', current: true },
        { label: 'GPT-5', current: false },
      ],
    });
    expect(deps.setMainModel).not.toHaveBeenCalled();
  });

  it('/model 合法编号 → 切换 + 反馈面板', async () => {
    const deps = makeDeps();
    const panel = await run({ kind: 'model', index: 2, invalid: false }, deps);
    expect(deps.setMainModel).toHaveBeenCalledWith('m2');
    expect(panel).toEqual({ kind: 'message', text: expect.stringContaining('slash.modelSwitched') });
  });

  it('/model 非法参数 → 用法面板；超界编号 → 失效面板（都不静默列清单）', async () => {
    const deps = makeDeps();
    expect(await run({ kind: 'model', index: null, invalid: true }, deps)).toEqual({
      kind: 'message',
      text: 'slash.modelUsage',
    });
    expect(await run({ kind: 'model', index: 9, invalid: false }, deps)).toEqual({
      kind: 'message',
      text: 'slash.modelStale',
    });
    expect(deps.setMainModel).not.toHaveBeenCalled();
  });

  it('/model 无注册模型 → 如实说「去设置里添加」', async () => {
    const deps = makeDeps({ listModels: vi.fn(async () => []) });
    expect(await run({ kind: 'model', index: null, invalid: false }, deps)).toEqual({
      kind: 'message',
      text: 'slash.modelEmpty',
    });
  });

  it('/compress → 新 ws 路由 conv.compress，四态反馈到面板', async () => {
    const mkResult = (over: Partial<ConvCompressResultEvent>): ConvCompressResultEvent => ({
      type: 'conv.compress.result',
      agentId: CTX.agentId,
      conversationId: CTX.convId,
      status: 'compressed',
      ...over,
    });
    const compress = vi.fn(async () => mkResult({ fallback: false }));
    const deps = makeDeps({ compress });
    const panel = await run({ kind: 'compress' }, deps);
    expect(compress).toHaveBeenCalledWith('a1', 'c1');
    expect(panel).toEqual({ kind: 'message', text: 'slash.compress.compressed' });

    const cases: Array<[ConvCompressResultEvent, string]> = [
      [mkResult({ fallback: true }), 'slash.compress.fallback'],
      [mkResult({ status: 'busy' }), 'slash.compress.busy'],
      [mkResult({ status: 'empty', emptyReason: 'tooShort' }), 'slash.compress.tooShort'],
      [mkResult({ status: 'empty', emptyReason: 'nothingNew' }), 'slash.compress.nothingNew'],
      [mkResult({ status: 'failed' }), 'slash.compress.failed'],
    ];
    for (const [res, key] of cases) {
      deps.compress = vi.fn(async () => res);
      expect(await run({ kind: 'compress' }, deps)).toEqual({ kind: 'message', text: key });
    }
  });

  it('/help → 命令清单面板', async () => {
    expect(await run({ kind: 'help' }, makeDeps())).toEqual({ kind: 'commands' });
  });

  it('/status → 状态快照面板（agent 名 / 挡位 / 模型 / 忙闲与排队，与飞书端同一份）', async () => {
    const deps = makeDeps({ isBusy: vi.fn(() => true), queuedCount: vi.fn(() => 2) });
    const panel = await run({ kind: 'status' }, deps);
    expect(panel).toEqual({
      kind: 'message',
      text: expect.stringContaining('slash.statusLine'),
    });
    // 快照四要素的取数都被问到
    expect(deps.agentInfo).toHaveBeenCalledWith('a1');
    expect(deps.listModels).toHaveBeenCalled();
    expect(deps.isBusy).toHaveBeenCalledWith('c1');
    expect(deps.queuedCount).toHaveBeenCalledWith('c1');
  });

  it('/status 模型未分配 → 如实显示「默认档」', async () => {
    const deps = makeDeps({ getTwinMain: vi.fn(async () => null) });
    const panel = await run({ kind: 'status' }, deps);
    expect(panel).toEqual({
      kind: 'message',
      text: expect.stringContaining('slash.statusDefaultModel'),
    });
  });
});
