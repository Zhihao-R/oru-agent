/**
 * #4 claude-code engine —— interrupt 驱动的近似中途转向（steerable 生成器状态机）。
 *
 * 验的是 ClaudeCodeBackend.runConversation 在 hasPendingSteering 挂着时走的活流路径：
 * 工具边界 interrupt 截断 → drainSteering 落盘 → appendInput 续喂；以及 C1/M2/M3 与回归。
 *
 * 用受控 fake live engine 替真 SDK：events 流由 inbox 驱动，interrupt()/appendInput() 被调时
 * 由测试脚本推入「下一段」事件，精确复现 spike v5 的时序（tool_result → 截断 result → 续喂 → 新轮 result）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EnginePromptBlock,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';
import type { ConversationInput } from '@shared/agent/backend';
import { makeToolContext } from '../helpers/toolContext';

// ─── 受控 fake live engine ──────────────────────────────────────
// emit 推事件 + 唤醒；interrupt/appendInput 触发测试注入的脚本回调。engine.run 委派到 current。

type FakeApi = { emit: (ev: EngineEvent) => void };
type FakeLive = {
  handle: EngineRunHandle;
  calls: { interrupt: number; appendInput: EnginePromptBlock[][]; runInputs: EngineRunInput[] };
};

function makeFakeLive(opts: {
  /** 首段事件（起回合那轮，通常以一个或多个 tool_result 结尾，等待 interrupt）。 */
  initial: EngineEvent[];
  /** interrupt() 被调时推入的事件（通常 error_during_execution result）。 */
  onInterrupt?: (api: FakeApi, n: number) => void;
  /** appendInput() 被调时推入的事件（续喂后的新轮，通常以 result 结尾）。 */
  onAppend?: (api: FakeApi, blocks: EnginePromptBlock[], n: number) => void;
}): FakeLive {
  const inbox: EngineEvent[] = [...opts.initial];
  let notify: (() => void) | null = null;
  let closed = false;
  function wake() {
    if (notify) {
      const n = notify;
      notify = null;
      n();
    }
  }
  const api: FakeApi = {
    emit: (ev) => {
      inbox.push(ev);
      wake();
    },
  };
  const calls = { interrupt: 0, appendInput: [] as EnginePromptBlock[][], runInputs: [] as EngineRunInput[] };
  async function* events(): AsyncGenerator<EngineEvent> {
    try {
      while (true) {
        while (inbox.length > 0) yield inbox.shift()!;
        if (closed) return;
        await new Promise<void>((r) => (notify = r));
      }
    } finally {
      closed = true;
    }
  }
  const handle: EngineRunHandle = {
    events: events(),
    interrupt: async () => {
      calls.interrupt += 1;
      opts.onInterrupt?.(api, calls.interrupt);
    },
    appendInput: (blocks) => {
      calls.appendInput.push(blocks);
      opts.onAppend?.(api, blocks, calls.appendInput.length);
    },
  };
  return { handle, calls };
}

const { fakeRef } = vi.hoisted(() => ({ fakeRef: { current: null as FakeLive | null } }));

vi.mock('../../electron/main/engine', () => {
  const engine = {
    run: (input: EngineRunInput): EngineRunHandle => {
      const fake = fakeRef.current;
      if (!fake) throw new Error('fakeRef 未设置');
      fake.calls.runInputs.push(input);
      return fake.handle;
    },
    mcp: {
      createServer: () => ({}),
      defineTool: (name: string) => ({ name }),
    },
  } satisfies CodeExecutionEngine;
  return { engine };
});

// factory 依赖 projects/store（拉真实 settings 会重）——只桩 getSettings
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn(),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings'>);

import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';

// ─── fixtures ───────────────────────────────────────────────────

const toolContext = makeToolContext({
  conversationId: 'conv-1',
  agentId: 'agent-1',
  ownerId: 'owner-1',
  approvalMode: 'work',
  usage: 'twinMain',
});

function makeInput(overrides: Partial<ConversationInput>): ConversationInput {
  return {
    agentId: 'agent-1',
    conversationId: 'conv-1',
    userMessage: '把首页标题改成蓝色',
    cwd: process.cwd(),
    abortController: new AbortController(),
    toolContext,
    ...overrides,
  };
}

const toolResult = (id: string): EngineEvent => ({
  type: 'tool_result',
  toolUseId: id,
  isError: false,
  content: 'ok',
});
const realResult = (text: string): EngineEvent => ({ type: 'result', resultText: text, isError: false });
const errResult = (): EngineEvent => ({ type: 'result', resultText: null, isError: true });

async function collect(events: AsyncIterable<unknown>): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for await (const ev of events) out.push(ev as Record<string, unknown>);
  return out;
}

afterEach(() => {
  fakeRef.current = null;
});

// ─── 主路径：工具边界中途转向 ──────────────────────────────────

describe('claude-code steerable：工具边界 interrupt 驱动续喂', () => {
  it('有待读入 → 工具边界 interrupt、吞掉截断 result、drain 落盘、appendInput 续喂、续喂轮 result 收尾', async () => {
    fakeRef.current = makeFakeLive({
      initial: [{ type: 'assistant_text', text: '正在改…' }, toolResult('t1')],
      onInterrupt: (api) => api.emit(errResult()),
      onAppend: (api) => api.emit(realResult('已改蓝并顺手调了配色')),
    });

    let pending = true; // 边界探测：第一次 true，被读走后置 false
    const drainCalls: number[] = [];
    const input = makeInput({
      hasPendingSteering: () => pending,
      drainSteering: async () => {
        drainCalls.push(1);
        pending = false;
        return ['顺便把配色也调一下'];
      },
    });

    const events = await collect(new ClaudeCodeBackend('claude-opus-4-8').runConversation(input).events);
    const fake = fakeRef.current!;

    // 起回合走活流模式
    expect(fake.calls.runInputs[0].live).toBe(true);
    // 工具边界 interrupt 一次
    expect(fake.calls.interrupt).toBe(1);
    // drain 落盘一次（消费）
    expect(drainCalls).toHaveLength(1);
    // appendInput 续喂，文本带「将生效」前缀
    expect(fake.calls.appendInput).toHaveLength(1);
    expect(fake.calls.appendInput[0]).toEqual([
      { type: 'text', text: '【用户中途补充】\n顺便把配色也调一下' },
    ]);
    // 消费者侧：截断的 error result 被吞、不外泄；只见透传事件 + 续喂轮的真 result
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ resultText: '已改蓝并顺手调了配色', isError: false });
    // assistant_text / tool_result 原样透传
    expect(events.find((e) => e.type === 'assistant_text')).toMatchObject({ text: '正在改…' });
    expect(events.find((e) => e.type === 'tool_result')).toMatchObject({ toolUseId: 't1' });
  });
});

// ─── 回归：无 steering 零变化 ──────────────────────────────────

describe('claude-code steerable：无待读入零变化（regression）', () => {
  it('hasPendingSteering 恒 false → 不 interrupt、不 drain、不 append，事件原样透传到 result', async () => {
    fakeRef.current = makeFakeLive({
      initial: [
        { type: 'assistant_text', text: '改完了' },
        toolResult('t1'),
        realResult('完成'),
      ],
    });
    let drained = 0;
    const input = makeInput({
      hasPendingSteering: () => false,
      drainSteering: async () => {
        drained += 1;
        return [];
      },
    });

    const events = await collect(new ClaudeCodeBackend('claude-opus-4-8').runConversation(input).events);
    const fake = fakeRef.current!;

    expect(fake.calls.interrupt).toBe(0);
    expect(fake.calls.appendInput).toHaveLength(0);
    expect(drained).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['assistant_text', 'tool_result', 'result']);
    expect(events.at(-1)).toMatchObject({ resultText: '完成', isError: false });
  });
});

// ─── M3：连续多轮 steering ─────────────────────────────────────

describe('claude-code steerable：连续多轮 interrupt（M3 状态机翻转）', () => {
  it('边界 A 续喂 → 续喂轮再到边界 B 又有待读入 → 又 interrupt → 再续喂 → 终轮收尾', async () => {
    // 队列里两批 steering，分别在边界 A、边界 B 被读走
    const batches = [['配色也调一下'], ['字体也换一下']];
    let pendingBatches = 2;
    fakeRef.current = makeFakeLive({
      initial: [toolResult('t1')], // 边界 A
      onInterrupt: (api) => api.emit(errResult()),
      onAppend: (api, _blocks, n) => {
        if (n === 1) {
          // 续喂第一批后的新轮：再出一个工具边界 B（仍有第二批待读入）
          api.emit(toolResult('t2'));
        } else {
          // 续喂第二批后：终轮收尾
          api.emit(realResult('蓝色+新配色+新字体都改好了'));
        }
      },
    });
    const input = makeInput({
      hasPendingSteering: () => pendingBatches > 0,
      drainSteering: async () => {
        const batch = batches[batches.length - pendingBatches];
        pendingBatches -= 1;
        return batch;
      },
    });

    const events = await collect(new ClaudeCodeBackend('claude-opus-4-8').runConversation(input).events);
    const fake = fakeRef.current!;

    // 两个边界各 interrupt 一次、各续喂一次
    expect(fake.calls.interrupt).toBe(2);
    expect(fake.calls.appendInput).toHaveLength(2);
    expect(fake.calls.appendInput[0]).toEqual([{ type: 'text', text: '【用户中途补充】\n配色也调一下' }]);
    expect(fake.calls.appendInput[1]).toEqual([{ type: 'text', text: '【用户中途补充】\n字体也换一下' }]);
    // 两个截断 result 都被吞，只见终轮 result
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ resultText: '蓝色+新配色+新字体都改好了' });
    // 两个工具边界都透传
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(2);
  });
});

// ─── #8 边界系统通知（后台终态）随 steering 同边界注入 ─────────

describe('claude-code steerable：drainBoundaryNotice 随 steering 同边界续喂（纯文本，不套补话前缀）', () => {
  it('有 steering + 有后台终态：appendInput 收到两块——补话块（带前缀）+ 通知块（纯文本）', async () => {
    fakeRef.current = makeFakeLive({
      initial: [toolResult('t1')],
      onInterrupt: (api) => api.emit(errResult()),
      onAppend: (api) => api.emit(realResult('改完并已知会后台结果')),
    });
    let pending = true;
    const input = makeInput({
      hasPendingSteering: () => pending,
      drainSteering: async () => {
        pending = false;
        return ['配色也调一下'];
      },
      drainBoundaryNotice: async () => ['[已完成但未播报的任务]\n- task t9 状态=done'],
    });

    await collect(new ClaudeCodeBackend('claude-opus-4-8').runConversation(input).events);
    const fake = fakeRef.current!;
    expect(fake.calls.appendInput).toHaveLength(1);
    expect(fake.calls.appendInput[0]).toEqual([
      { type: 'text', text: '【用户中途补充】\n配色也调一下' },
      { type: 'text', text: '[已完成但未播报的任务]\n- task t9 状态=done' },
    ]);
  });

  it('无后台终态：只续喂补话块（drainBoundaryNotice 返回空不产生多余块）', async () => {
    fakeRef.current = makeFakeLive({
      initial: [toolResult('t1')],
      onInterrupt: (api) => api.emit(errResult()),
      onAppend: (api) => api.emit(realResult('done')),
    });
    let pending = true;
    const input = makeInput({
      hasPendingSteering: () => pending,
      drainSteering: async () => {
        pending = false;
        return ['只补一句'];
      },
      drainBoundaryNotice: async () => [],
    });
    await collect(new ClaudeCodeBackend('claude-opus-4-8').runConversation(input).events);
    expect(fakeRef.current!.calls.appendInput[0]).toEqual([
      { type: 'text', text: '【用户中途补充】\n只补一句' },
    ]);
  });
});

// ─── 撤回竞态 / C1：空 drain 干净收尾 ──────────────────────────

describe('claude-code steerable：空 drain 干净收尾（撤回竞态 / C1 兜底）', () => {
  it('边界探测到待读入触发 interrupt，但 drain 时已被撤回（空）→ 不 append、收一个非错误 result 结束', async () => {
    fakeRef.current = makeFakeLive({
      initial: [toolResult('t1')],
      onInterrupt: (api) => api.emit(errResult()),
    });
    const input = makeInput({
      hasPendingSteering: () => true, // 边界看到「有」
      drainSteering: async () => [], // 但 pull 那刻已被撤回 → 空
    });

    const events = await collect(new ClaudeCodeBackend('claude-opus-4-8').runConversation(input).events);
    const fake = fakeRef.current!;

    expect(fake.calls.interrupt).toBe(1);
    expect(fake.calls.appendInput).toHaveLength(0); // 无可续喂
    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    // 截断 result 被映射为非错误收尾（不给用户报错；partial 已进 session、撤回的不在历史）
    expect(results[0]).toMatchObject({ isError: false });
  });
});
