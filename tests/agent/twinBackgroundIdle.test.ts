/**
 * runTwinBackground 超时语义回归——从「90s 总时长硬杀」改为事件流空闲看门狗后：
 *
 * 1. 还在干活不杀：事件持续到达、总时长远超旧 90s 上限，查询正常完成（旧实现会在
 *    90s 处 abort、把干到一半的查询杀掉——本用例在旧实现下必挂）。
 * 2. 卡死才杀：流静默超过 STREAM_IDLE_TIMEOUT_MS，看门狗 abort，返回 isError
 *    （调用方 askTwinBridge / askTwinResolver 据此升级给用户）。
 *
 * ORU_DIR 范式 + __setBackendFactoryForTest 注入 stub backend（同 runnerBusyLock）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { AgentBackend, ConversationInput } from '@shared/agent/backend';

const ORU_DIR = join(tmpdir(), `oru-test-twin-bg-idle-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

/** 每个事件间隔（fake timers 推进），由用例设置 */
let eventGapsMs: number[] = [];

function makeBackend(): AgentBackend {
  return {
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
    runConversation: (input: ConversationInput) => {
      const signal = input.abortController?.signal;
      return {
        events: (async function* () {
          for (const gap of eventGapsMs) {
            await new Promise((r) => setTimeout(r, gap));
            // 模拟真实 backend：abort 后流以 AbortError 收场（不再产出终态 result）
            if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
            yield { type: 'assistant_text' as const, text: '段' };
          }
          yield { type: 'result' as const, resultText: '查询完成', isError: false };
        })(),
      };
    },
    runOneShot: async () => ({ text: 'unused' }),
    registerTool: () => {},
    unregisterTool: () => {},
    isReady: async () => ({ ok: true, hint: 'mock' }),
  } satisfies AgentBackend;
}

let agentId: string;
let restoreFactory: () => void;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  // 行为不靠 debugLogger 恰好关闭——显式关掉（instrumentConversation 透传路径）
  const { debugLogger } = await import('../../electron/main/debug/logger');
  debugLogger.setEnabled(false);
  const { ensureDefaultAgent } = await import('../../electron/main/agent/store/agents');
  agentId = (await ensureDefaultAgent()).id;
  const { __setBackendFactoryForTest } = await import('../../electron/main/agent/backends/factory');
  restoreFactory = __setBackendFactoryForTest(async () => makeBackend());
});

afterAll(async () => {
  restoreFactory();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * 分步推进 fake timers 直到 promise 落定——流启动前有真实异步段（读 agent / 供能 / 配置），
 * 一次性大步推进会赶在事件流的 timer 注册之前跑完、之后永远无人推进。
 * 每步先用真实 setImmediate 让事件循环跑一轮（IO 回调得以完成；配合 toFake 只伪造
 * setTimeout 族），再推 mock 时钟。maxSteps 用尽仍未落定就直接 await（vitest 超时暴露问题）。
 */
async function advanceUntilSettled<T>(p: Promise<T>, stepMs: number, maxSteps: number): Promise<T> {
  let settled = false;
  const guarded = p.finally(() => {
    settled = true;
  });
  for (let i = 0; i < maxSteps && !settled; i++) {
    // 无 mock 计时器在挂 = 还在真实 IO 段（读 agent / 配置）——空转事件循环等它注册，不计步
    for (let spin = 0; spin < 1000 && !settled && vi.getTimerCount() === 0; spin++) {
      await new Promise((r) => setImmediate(r));
    }
    if (settled) break;
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  return guarded;
}

/** 只伪造 setTimeout 族（被测代码只用它）——留真 setImmediate 给 advanceUntilSettled 驱动 IO */
function useFakeSetTimeout(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
}

describe('runTwinBackground 空闲看门狗', () => {
  it('事件持续到达:总时长 8 分钟(远超旧 90s 上限)仍正常完成(回归:旧总时长硬杀会误杀)', async () => {
    const { runTwinBackground } = await import('../../electron/main/agent/twinBackgroundQuery');
    useFakeSetTimeout();
    const TWO_MIN = 2 * 60_000;
    eventGapsMs = [TWO_MIN, TWO_MIN, TWO_MIN, TWO_MIN]; // 4 × 2 分钟 = 8 分钟
    const p = runTwinBackground({ agentId, prompt: '慢查询', taskId: null, escalateHandler: null });
    const r = await advanceUntilSettled(p, 30_000, 40); // 最多推 20 分钟
    expect(r.isError).toBe(false);
    expect(r.resultText).toContain('段');
  });

  it('流静默超过阈值 → 看门狗 abort,返回 isError(卡死才杀)', async () => {
    const { runTwinBackground } = await import('../../electron/main/agent/twinBackgroundQuery');
    useFakeSetTimeout();
    eventGapsMs = [1000, 60 * 60_000]; // 第一个事件后静默一小时——静默超阈值处看门狗 abort
    const p = runTwinBackground({ agentId, prompt: '卡死查询', taskId: null, escalateHandler: null });
    const r = await advanceUntilSettled(p, 60_000, 100); // 最多推 100 分钟
    expect(r.isError).toBe(true);
  });
});
