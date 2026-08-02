/**
 * 条款闸误杀自动重试（spawn 阶段瞬时失败）。
 *
 * 背景：SDK 自带 CLI 启动时对 OAuth 消费者账户复查条款——并行拉账户 settings 与条款配置，
 * settings 偶发失败（超时/限流）而条款配置成功且宽限期已过 → print 模式弹不出确认 →
 * stderr 打 "[ACTION REQUIRED] …" 后 exit(1)。账户已接受条款也照样误杀（fail-closed 上游缺陷）。
 * 该死法发生在任何事件产出之前 → retryStreamStart 的「首事件前可重试」边界天然安全覆盖。
 *
 * 谓词刻意窄匹配：只认条款闸文案。鉴权失败 / 模型不可用等确定性 exit 1 不重试，照旧立刻透出。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';
import type { ConversationInput } from '@shared/agent/backend';

// 受控 fake engine：每次 run() 按 attempts 剧本决定「spawn 即死」还是正常产出事件
type RunScript = { die?: Error; events?: EngineEvent[] };
let runScripts: RunScript[] = [];
let runCalls = 0;
vi.mock('../../electron/main/engine', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../electron/main/engine')>();
  const engine = {
    run: (_input: EngineRunInput): EngineRunHandle => {
      const script = runScripts[Math.min(runCalls, runScripts.length - 1)];
      runCalls++;
      async function* gen(): AsyncGenerator<EngineEvent> {
        if (script.die) throw script.die;
        for (const e of script.events ?? []) yield e;
      }
      return { events: gen() };
    },
    mcp: orig.engine.mcp,
  } satisfies CodeExecutionEngine;
  return { ...orig, engine };
});

vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

import {
  ClaudeCodeBackend,
  isTermsGateExit,
  withSpawnRetry,
} from '../../electron/main/agent/backends/claudeCode';
import { DEFAULT_RETRY } from '../../electron/main/agent/util/retry';

/** 生产路径 enrichProcessExitError 拼出的真实错误形态（stderr 末尾补进 message） */
const termsGateError = () =>
  new Error(
    [
      'Claude Code process exited with code 1',
      '',
      'Claude Code 子进程 stderr（末尾）：',
      '[ACTION REQUIRED] An update to our Consumer Terms and Privacy Policy has taken effect on October 8, 2025. You must run `claude` to review the updated terms.',
    ].join('\n'),
  );

const authError = () =>
  new Error(
    'Claude Code process exited with code 1\n\nClaude Code 子进程 stderr（末尾）：\nInvalid API key · Please run /login',
  );

const okEvents: EngineEvent[] = [
  { type: 'assistant_text', text: '好' },
  { type: 'result', resultText: '好', isError: false },
];

const FAST_RETRY = { ...DEFAULT_RETRY, maxRetries: 3, backoffScheduleSeconds: [0, 0, 0] };

async function drain(events: AsyncIterable<EngineEvent>): Promise<EngineEvent[]> {
  const out: EngineEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

beforeEach(() => {
  runScripts = [];
  runCalls = 0;
});

describe('isTermsGateExit', () => {
  it('命中条款闸误杀（进程退出 + ACTION REQUIRED 条款文案）', () => {
    expect(isTermsGateExit(termsGateError())).toBe(true);
  });

  it('不命中其他 exit 1（鉴权失败等确定性错误照旧立刻透出）', () => {
    expect(isTermsGateExit(authError())).toBe(false);
  });

  it('不命中非进程退出错误 / 非 Error', () => {
    expect(isTermsGateExit(new Error('fetch failed'))).toBe(false);
    expect(isTermsGateExit('ACTION REQUIRED')).toBe(false);
  });
});

describe('withSpawnRetry', () => {
  // 每次 open() 消费一个剧本项（Error=spawn 即死 / 事件数组=正常产出）；越界复用最后一项
  function makeOpen(...attempts: Array<Error | EngineEvent[]>) {
    let i = 0;
    let calls = 0;
    const open = (): AsyncIterable<EngineEvent> => {
      calls++;
      const a = attempts[Math.min(i++, attempts.length - 1)];
      return (async function* () {
        if (a instanceof Error) throw a;
        for (const e of a) yield e;
      })();
    };
    return { open, callCount: () => calls };
  }

  it('首事件前条款闸死 → 自动重试成功，先出 retrying 再出正常事件', async () => {
    const { open, callCount } = makeOpen(termsGateError(), okEvents);
    const out = await drain(withSpawnRetry(open, new AbortController().signal, FAST_RETRY));
    expect(callCount()).toBe(2);
    expect(out[0]).toEqual({ type: 'retrying', attempt: 1, maxRetries: 3 });
    expect(out.slice(1)).toEqual(okEvents);
  });

  it('已产出事件后再死 → 不重试，原样抛（交续写/错误条，不重复内容）', async () => {
    let calls = 0;
    const open = (): AsyncIterable<EngineEvent> => {
      calls++;
      return (async function* () {
        yield okEvents[0];
        throw termsGateError();
      })();
    };
    await expect(drain(withSpawnRetry(open, new AbortController().signal, FAST_RETRY))).rejects.toThrow(
      'ACTION REQUIRED',
    );
    expect(calls).toBe(1);
  });

  it('非条款类 spawn 死 → 不重试（鉴权失败重试 3 次纯属折磨）', async () => {
    const { open, callCount } = makeOpen(authError());
    await expect(drain(withSpawnRetry(open, new AbortController().signal, FAST_RETRY))).rejects.toThrow(
      'Invalid API key',
    );
    expect(callCount()).toBe(1);
  });

  it('重试用尽仍死 → 抛（1 + maxRetries 次尝试）', async () => {
    const { open, callCount } = makeOpen(termsGateError());
    await expect(drain(withSpawnRetry(open, new AbortController().signal, FAST_RETRY))).rejects.toThrow(
      'ACTION REQUIRED',
    );
    expect(callCount()).toBe(4);
  });
});

describe('ClaudeCodeBackend 接线（回归：条款闸误杀不再整轮报错）', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeInput(overrides: Partial<ConversationInput> = {}): ConversationInput {
    return {
      agentId: 'agent-1',
      conversationId: 'conv-1',
      userMessage: 'hi',
      cwd: process.cwd(),
      abortController: new AbortController(),
      ...overrides,
    };
  }

  it('runConversation 单发路径：第一次 spawn 条款闸死、第二次正常 → 事件照常产出', async () => {
    runScripts = [{ die: termsGateError() }, { events: okEvents }];
    const backend = new ClaudeCodeBackend('claude-opus-4-8');
    const p = drain(backend.runConversation(makeInput()).events as AsyncIterable<EngineEvent>);
    await vi.runAllTimersAsync();
    const out = await p;
    expect(runCalls).toBe(2);
    expect(out.map((e) => e.type)).toEqual(['retrying', 'assistant_text', 'result']);
  });

  it('runConversation steering 路径同样覆盖', async () => {
    runScripts = [{ die: termsGateError() }, { events: okEvents }];
    const backend = new ClaudeCodeBackend('claude-opus-4-8');
    const p = drain(
      backend.runConversation(makeInput({ hasPendingSteering: () => false }))
        .events as AsyncIterable<EngineEvent>,
    );
    await vi.runAllTimersAsync();
    const out = await p;
    expect(runCalls).toBe(2);
    expect(out.some((e) => e.type === 'retrying')).toBe(true);
    expect(out.at(-1)?.type).toBe('result');
  });

  it('runOneShot：条款闸死一次后重试拿到终值', async () => {
    runScripts = [{ die: termsGateError() }, { events: okEvents }];
    const backend = new ClaudeCodeBackend('claude-opus-4-8');
    const p = backend.runOneShot({ prompt: 'hi' });
    await vi.runAllTimersAsync();
    await expect(p).resolves.toMatchObject({ text: '好' });
    expect(runCalls).toBe(2);
  });

  it('runConversation：非条款类 spawn 死照旧抛出（不误吞真错误）', async () => {
    runScripts = [{ die: authError() }];
    const backend = new ClaudeCodeBackend('claude-opus-4-8');
    const p = drain(backend.runConversation(makeInput()).events as AsyncIterable<EngineEvent>);
    p.catch(() => {}); // 防 unhandled rejection 噪音；下面再正式断言
    await vi.runAllTimersAsync();
    await expect(p).rejects.toThrow('Invalid API key');
    expect(runCalls).toBe(1);
  });
});
