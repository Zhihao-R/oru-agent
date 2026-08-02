/**
 * pipeSdkToEventsForTask：失败真因透出 + 成功/失败判据回归
 *
 * 背景：claude-code 后端的 task 收到上游 529 时，子进程先吐一条 isError 的 result（真因），
 * 紧接着退出抛 "exited with code 1"。修复前真因被退出码盖掉、UI 只剩 code 1；且 isError 的
 * result 若赶上子进程正常退出，会被当 done 收工。本套锁住几条不变量：
 * - 中途抛错时，已吐的 isError 错误文本（resultText）优先于退出码（真因不丢）
 * - isError 的 result 一律视为失败（throw），不论子进程之后是否抛异常（不把失败标成功）
 * - 失败真因只认 SDK 的 result 错误文本，不拿模型独白（assistant_text）冒充：
 *   resultText 缺失时，中途抛错退回原始异常（保 enrichProcessExitError 的 stderr）、正常退出给兜底语
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerEventPayload } from '@shared/protocol';
import type { EngineEvent } from '../../electron/main/engine';

// mock 锚到真实签名（typeof import）——接口变形这里会红，不裸对象蒙混
const { appendTaskEventMock } = vi.hoisted(() => ({
  appendTaskEventMock: vi.fn<(typeof import('../../electron/main/tasks/store'))['appendTaskEvent']>(),
}));
vi.mock('../../electron/main/tasks/store', () => ({ appendTaskEvent: appendTaskEventMock }));

import { pipeSdkToEventsForTask } from '../../electron/main/tasks/stream';

/** 把事件数组包成异步流；throwAtEnd 模拟流末尾抛错（如子进程退出）。 */
async function* streamOf(events: EngineEvent[], throwAtEnd?: Error): AsyncIterable<EngineEvent> {
  for (const ev of events) yield ev;
  if (throwAtEnd) throw throwAtEnd;
}

const PROCESS_EXIT = 'Claude Code process exited with code 1';
const OVERLOAD = 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}';

/** 跑一遍并捕获被 reject 的错误对象，便于对 message 做正反双向断言。 */
function runAndCatch(events: EngineEvent[], throwAtEnd: Error | undefined, ctx: { taskId: string; emit: ReturnType<typeof vi.fn> }): Promise<Error> {
  return pipeSdkToEventsForTask(streamOf(events, throwAtEnd), ctx).then(
    () => {
      throw new Error('期望 reject，却 resolve 了');
    },
    (e) => e as Error,
  );
}

describe('pipeSdkToEventsForTask 失败真因', () => {
  const emit = vi.fn<(ev: ServerEventPayload) => void>();
  const ctx = { taskId: 'tsk_test', emit };

  beforeEach(() => {
    vi.clearAllMocks();
    appendTaskEventMock.mockResolvedValue(undefined);
  });

  it('中途抛进程退出错误时，已吐的 isError 错误文本覆盖退出码', async () => {
    const err = await runAndCatch(
      [
        { type: 'assistant_text', text: '正在生成 PPT' },
        { type: 'result', resultText: OVERLOAD, isError: true },
      ],
      new Error(PROCESS_EXIT),
      ctx,
    );
    expect(err.message).toContain('529');
    expect(err.message).not.toContain('exited with code');
  });

  it('isError 的 result 即便子进程正常退出（不抛错）也判为失败', async () => {
    const err = await runAndCatch([{ type: 'result', resultText: OVERLOAD, isError: true }], undefined, ctx);
    expect(err.message).toContain('529');
  });

  it('isError 但无错误文本时，退回原始异常（含 stderr），不拿模型独白冒充真因', async () => {
    const enriched = `${PROCESS_EXIT}\n\nClaude Code 子进程 stderr（末尾）：\nauth failed`;
    const err = await runAndCatch(
      [
        { type: 'assistant_text', text: '我正在分析代码' },
        { type: 'result', resultText: null, isError: true },
      ],
      new Error(enriched),
      ctx,
    );
    expect(err.message).toContain('auth failed');
    expect(err.message).not.toContain('我正在分析代码');
  });

  it('isError 正常退出但无错误文本，给兜底语、不抛空串/独白', async () => {
    const err = await runAndCatch(
      [
        { type: 'assistant_text', text: '我正在分析代码' },
        { type: 'result', resultText: null, isError: true },
      ],
      undefined,
      ctx,
    );
    expect(err.message).not.toBe('');
    expect(err.message).not.toContain('我正在分析代码');
    expect(err.message).toContain('未给出原因');
  });

  it('纯崩溃（非 isError）原样抛原始异常，不被半截独白覆盖', async () => {
    const enriched = `${PROCESS_EXIT}\n\nClaude Code 子进程 stderr（末尾）：\nspawn ENOENT`;
    const err = await runAndCatch([{ type: 'assistant_text', text: '写到一半' }], new Error(enriched), ctx);
    expect(err.message).toContain('spawn ENOENT');
    expect(err.message).not.toContain('写到一半');
  });

  it('用户取消（AbortError，无 isError result）原样透传，不被当失败真因吞掉', async () => {
    // 取消正在跑的任务：流抛 AbortError，此前没有 isError 的 result（任务在正常跑）。
    // isError=false → 走 throw e，AbortError 原样透出；上层据此识别取消，不写成普通 failed。
    const err = await runAndCatch(
      [{ type: 'assistant_text', text: '正在生成 PPT' }],
      new DOMException('Aborted', 'AbortError'),
      ctx,
    );
    expect(err.name).toBe('AbortError');
    expect(err.message).not.toContain('正在生成 PPT');
  });

  it('正常成功：返回 result 摘要，不 throw', async () => {
    await expect(
      pipeSdkToEventsForTask(
        streamOf([
          { type: 'assistant_text', text: '正在做' },
          { type: 'result', resultText: '已完成改动', isError: false },
        ]),
        ctx,
      ),
    ).resolves.toEqual({ summary: '已完成改动' });
  });
});
