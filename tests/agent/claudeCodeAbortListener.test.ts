/**
 * runOneShot abort 监听器清理回归——目标问题：上游 signal 跨多次 runOneShot 复用
 * （如 dream 批量调用）时，旧实现每次调用都在 signal 上挂一个永不移除的 'abort'
 * 监听器，累积泄漏。修复后 {once} + finally removeEventListener 双保险：
 * 调用结束（无论成败）signal 上监听器数归零。
 */
import { describe, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import type {
  CodeExecutionEngine,
  EngineEvent,
  EngineRunHandle,
  EngineRunInput,
} from '../../electron/main/engine/types';

vi.mock('../../electron/main/engine', async (importOriginal) => {
  // 透传原始导出（PROCESS_EXIT_ERROR_RE 等），只替换 engine 本体
  const orig = await importOriginal<typeof import('../../electron/main/engine')>();
  return {
    ...orig,
    engine: {
      run: vi.fn((_input: EngineRunInput): EngineRunHandle => ({
        events: (async function* (): AsyncGenerator<EngineEvent> {
          yield { type: 'result', resultText: 'ok', isError: false, usage: undefined };
        })(),
      })),
      mcp: orig.engine.mcp,
    } satisfies CodeExecutionEngine,
  };
});

import { ClaudeCodeBackend } from '../../electron/main/agent/backends/claudeCode';

describe('claudeCode runOneShot abort 监听器', () => {
  it('同一 signal 连续多次 runOneShot：结束后监听器数归零，不累积', async () => {
    const backend = new ClaudeCodeBackend();
    const ac = new AbortController();

    for (let i = 0; i < 3; i++) {
      await backend.runOneShot({ prompt: `第 ${i} 次` }, ac.signal);
    }
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });

  it('传入已 aborted 的 signal：立即 AbortError 拒绝、不 spawn（联动线被删则会正常跑完→测试红）', async () => {
    // 原断言「engine.run 收到已 aborted 的 controller」——条款闸重试接入后（withSpawnRetry），
    // 已 aborted 的 signal 在 spawn 之前就被 retryStreamStart 拦下抛 AbortError，engine.run
    // 根本不会被调。真实 SDK 拿到已 aborted 的 controller 本就立刻抛 AbortError，新契约与
    // 真实行为一致且省一次白 spawn。联动回归（signal?.aborted → abort.abort() 被删）仍被守：
    // 联动线不在，内部 signal 未 aborted → 正常跑完 resolve → 本断言失败。
    const { engine } = await import('../../electron/main/engine');
    const runSpy = engine.run as ReturnType<typeof vi.fn>;
    runSpy.mockClear();
    const backend = new ClaudeCodeBackend();
    await expect(backend.runOneShot({ prompt: 'x' }, AbortSignal.abort())).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('engine 抛错路径同样清理（finally 兜底）', async () => {
    const { engine } = await import('../../electron/main/engine');
    (engine.run as ReturnType<typeof vi.fn>).mockImplementationOnce(() => ({
      events: (async function* () {
        throw new Error('engine 崩了');
        yield undefined as never; // 让 TS 认定这是 generator
      })(),
    }));
    const backend = new ClaudeCodeBackend();
    const ac = new AbortController();
    await expect(backend.runOneShot({ prompt: 'x' }, ac.signal)).rejects.toThrow('engine 崩了');
    expect(getEventListeners(ac.signal, 'abort')).toHaveLength(0);
  });
});
