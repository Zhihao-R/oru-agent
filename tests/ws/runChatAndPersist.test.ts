/**
 * runChatAndPersist 中断路径单元测试。
 *
 * 验证 Fix 3：流被中断（带半截）时
 *  - 落一条 incomplete assistant 消息（appendMessage 一次）
 *  - 与成功路径一致地触发记忆捕获（captureOnAssistantMessage）
 *  - **不**调 onAssistantPersisted——comment 路径的它会再 emit 一次 chat.done，
 *    而 catch 末尾已无条件 emit，调了就双发
 *  - chat.done 恰好一次
 *
 * 以及「用户主动刹停不算错误」（2026-07 通知中心误报修复）：
 *  - reason='aborted'（runner 按 signal 状态挂，不靠错误文案）→ 不 emit chat.error——
 *    chat.error 会置 message.error → conversationStatus 'errored' → 通知中心「需要你处理」，
 *    用户自己按的停不该进去；对话内「已中断」呈现由 abortedByUser + interrupted 半截驱动，不受影响
 *  - 真错误（upstream_error / 无 interruptedTurn）→ chat.error 照发（防误伤对照）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { attachInterruptedTurn, type InterruptedTurn } from '../../electron/main/agent/interrupted';
import { IdleTimeoutError } from '../../electron/main/agent/util/retry';

const { runChatMock, appendMessageMock, captureMock } = vi.hoisted(() => ({
  runChatMock: vi.fn(),
  appendMessageMock: vi.fn(),
  captureMock: vi.fn(),
}));
vi.mock('../../electron/main/agent/runner', () => ({
  runChat: runChatMock,
  clearActivePartial: vi.fn(),
}));
vi.mock('../../electron/main/conversations/store', () => ({ appendMessage: appendMessageMock }));
vi.mock('../../electron/main/memory/captureScheduler', () => ({ onAssistantMessage: captureMock }));

import { runChatAndPersist } from '../../electron/main/ws/runChatAndPersist';

function interruptedError(
  reason: InterruptedTurn['reason'] = 'aborted',
  resultText = '半截输出',
): Error {
  const err = new Error('aborted');
  const turn: InterruptedTurn = {
    partial: { resultText, toolCalls: [] },
    reason,
    meta: { backendType: 'claude' as never, toolProtocol: 'native' as never },
  };
  attachInterruptedTurn(err, turn);
  return err;
}

describe('runChatAndPersist - 中断回合', () => {
  beforeEach(() => {
    runChatMock.mockReset();
    appendMessageMock.mockReset().mockResolvedValue(undefined);
    captureMock.mockReset();
  });

  it('中断落 incomplete 后触发 capture、不调 onAssistantPersisted、chat.done 只发一次', async () => {
    runChatMock.mockRejectedValue(interruptedError());
    const onAssistantPersisted = vi.fn(async () => {});
    const emitted: Array<{ type: string }> = [];

    await runChatAndPersist({
      agent: { id: 'a1', ownerId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      emit: (ev: { type: string }) => emitted.push(ev),
      onAssistantPersisted,
    } as never);

    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    // 第三参是本回合的项目归属：这条用例没给 projectIdOverride，透传 undefined
    // 即"未指定"，由 captureScheduler 回落到全局活跃项目
    expect(captureMock).toHaveBeenCalledWith('a1', 'c1', undefined);
    expect(onAssistantPersisted).not.toHaveBeenCalled();
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('本回合的项目归属透传给 capture——评论/定时回合不该继承桌面当前项目', async () => {
    runChatMock.mockRejectedValue(interruptedError());
    await runChatAndPersist({
      agent: { id: 'a1', ownerId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      emit: () => {},
      onAssistantPersisted: vi.fn(async () => {}),
      projectIdOverride: 'prj_task',
    } as never);
    expect(captureMock).toHaveBeenCalledWith('a1', 'c1', 'prj_task');
  });

  // 按停后残余「待验收」未读徽标的根因回归（2026-07）：中断半截落盘会顶高后端 updatedAt，
  // 但此前不推 conv.state → 停在对话里的人水位追不上 → 下次同步冒出未读。onInterruptedPersisted
  // 补这一次列表同步（前端 useMarkDisplayedConvSeen 据此为「正看着的对话」盖章；没在看的不盖 = 保持未读）。
  // 它只做列表同步、绝不 emit chat.done（那是 onAssistantPersisted 的活，会与 catch 末尾双发）。
  it('中断落 incomplete 后调 onInterruptedPersisted（传半截消息）、不双发 chat.done', async () => {
    runChatMock.mockRejectedValue(interruptedError());
    const onInterruptedPersisted = vi.fn(async () => {});
    const emitted: Array<{ type: string }> = [];

    await runChatAndPersist({
      agent: { id: 'a1', ownerId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      emit: (ev: { type: string }) => emitted.push(ev),
      onInterruptedPersisted,
    } as never);

    expect(onInterruptedPersisted).toHaveBeenCalledTimes(1);
    expect(onInterruptedPersisted.mock.calls[0][0]).toMatchObject({
      id: 'm1',
      conversationId: 'c1',
      role: 'assistant',
    });
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('半截为空（一个 token 没出，不落盘）→ 不调 onInterruptedPersisted', async () => {
    runChatMock.mockRejectedValue(interruptedError('aborted', ''));
    const onInterruptedPersisted = vi.fn(async () => {});

    await runChatAndPersist({
      agent: { id: 'a1', ownerId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      emit: () => {},
      onInterruptedPersisted,
    } as never);

    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(onInterruptedPersisted).not.toHaveBeenCalled();
  });
});

describe('runChatAndPersist - 用户主动刹停不算错误', () => {
  beforeEach(() => {
    runChatMock.mockReset();
    appendMessageMock.mockReset().mockResolvedValue(undefined);
    captureMock.mockReset();
  });

  async function run(err: Error): Promise<Array<{ type: string }>> {
    runChatMock.mockRejectedValue(err);
    const emitted: Array<{ type: string }> = [];
    await runChatAndPersist({
      agent: { id: 'a1', ownerId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      emit: (ev: { type: string }) => emitted.push(ev),
    } as never);
    return emitted;
  }

  it('用户 abort（带半截）→ 不 emit chat.error，半截照落，chat.done 照发', async () => {
    const emitted = await run(interruptedError('aborted'));
    expect(emitted.filter((e) => e.type === 'chat.error')).toHaveLength(0);
    expect(emitted.filter((e) => e.type === 'error')).toHaveLength(0);
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('用户 abort（半截为空，一个 token 没出）→ 不 emit chat.error、不落空壳，chat.done 照发', async () => {
    const emitted = await run(interruptedError('aborted', ''));
    expect(emitted.filter((e) => e.type === 'chat.error')).toHaveLength(0);
    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('对照：上游挂死（upstream_error 带半截）→ chat.error 照发', async () => {
    const emitted = await run(interruptedError('upstream_error'));
    expect(emitted.filter((e) => e.type === 'chat.error')).toHaveLength(1);
    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('对照：真错误（无 interruptedTurn）→ chat.error 照发', async () => {
    const emitted = await run(new Error('backend 挂了'));
    expect(emitted.filter((e) => e.type === 'chat.error')).toHaveLength(1);
    expect(appendMessageMock).not.toHaveBeenCalled();
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });
});

describe('runChatAndPersist - 断线自动接续（S25 G23/G03）', () => {
  beforeEach(() => {
    runChatMock.mockReset();
    appendMessageMock.mockReset().mockResolvedValue(undefined);
    captureMock.mockReset();
  });

  /** 可重试的流中断（网络层）：IdleTimeoutError 带半截，reason=upstream_error。 */
  function retryableDrop(resultText = '半截输出'): Error {
    const err = new IdleTimeoutError(60_000) as Error;
    attachInterruptedTurn(err, {
      partial: { resultText, toolCalls: [] },
      reason: 'upstream_error',
      meta: { backendType: 'claude' as never, toolProtocol: 'native' as never },
    });
    return err;
  }

  async function run(err: Error, onRetryableStreamDrop?: (m: unknown) => Promise<boolean>) {
    runChatMock.mockRejectedValue(err);
    const emitted: Array<{ type: string }> = [];
    const outcome = await runChatAndPersist({
      agent: { id: 'a1', ownerId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      emit: (ev: { type: string }) => emitted.push(ev),
      onRetryableStreamDrop,
    } as never);
    return { emitted, outcome };
  }

  it('可重试断线 + 接手（返回 true）→ 抑制 chat.error、半截照落、回调拿到 incomplete', async () => {
    const onDrop = vi.fn(async () => true);
    const { emitted } = await run(retryableDrop(), onDrop);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(onDrop.mock.calls[0][0]).toMatchObject({ id: 'm1', role: 'assistant' });
    expect(emitted.filter((e) => e.type === 'chat.error')).toHaveLength(0); // 红条被抑制
    expect(appendMessageMock).toHaveBeenCalledTimes(1); // 半截仍落盘
    expect(emitted.filter((e) => e.type === 'chat.done')).toHaveLength(1);
  });

  it('可重试断线 + 预算用尽（返回 false）→ chat.error 照发', async () => {
    const onDrop = vi.fn(async () => false);
    const { emitted } = await run(retryableDrop(), onDrop);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(emitted.filter((e) => e.type === 'chat.error')).toHaveLength(1);
  });

  it('不可重试错（无 onRetryableStreamDrop 也一样）→ 不触发接续、chat.error 照发', async () => {
    // 普通 Error 经 classifyError 判不可重试 → 不够格自动续写
    const onDrop = vi.fn(async () => true);
    const { emitted } = await run(interruptedError('upstream_error'), onDrop);
    expect(onDrop).not.toHaveBeenCalled();
    expect(emitted.filter((e) => e.type === 'chat.error')).toHaveLength(1);
  });

  it('用户 abort（可重试类错但 reason=aborted）→ 不触发接续', async () => {
    const err = new IdleTimeoutError(60_000) as Error;
    attachInterruptedTurn(err, {
      partial: { resultText: '半截', toolCalls: [] },
      reason: 'aborted',
      meta: { backendType: 'claude' as never, toolProtocol: 'native' as never },
    });
    const onDrop = vi.fn(async () => true);
    const { emitted } = await run(err, onDrop);
    expect(onDrop).not.toHaveBeenCalled();
    expect(emitted.filter((e) => e.type === 'chat.error')).toHaveLength(0);
  });

  it('半截为空（一个 token 没出）→ 不触发接续（M3 前提是已产出半截）', async () => {
    const err = new IdleTimeoutError(60_000) as Error;
    attachInterruptedTurn(err, {
      partial: { resultText: '', toolCalls: [] },
      reason: 'upstream_error',
      meta: { backendType: 'claude' as never, toolProtocol: 'native' as never },
    });
    const onDrop = vi.fn(async () => true);
    await run(err, onDrop);
    expect(onDrop).not.toHaveBeenCalled();
  });
});

describe('runChatAndPersist - 回合消息 createdAt 盖回合开始时刻（重载排序回归）', () => {
  // 根因：信息流按 createdAt 排序（ChatArea items sort），回合中途注入的卡
  // （memory-record / git-hint / skill chip，turnArgs.ts 里 Date.now() 落盘）时间戳夹在
  // 回合开始与结束之间。assistant 消息直播时渲染层按「回合开始」参与排序，落盘若盖
  // 「回合结束」，重载后 assistant 排到中途卡之后——卡从流底跳到用户气泡下（2026-07-24 截图）。
  // 契约：落盘 createdAt = 进入 runChatAndPersist 的时刻，成功与中断半截两路一致。
  beforeEach(() => {
    runChatMock.mockReset();
    appendMessageMock.mockReset().mockResolvedValue(undefined);
    captureMock.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('成功路径：回合跑了 30s，落盘 createdAt 仍是开始时刻（< 中途卡的时间戳）', async () => {
    const t0 = Date.now();
    runChatMock.mockImplementation(async () => {
      vi.advanceTimersByTime(30_000); // 模拟回合期间流逝（工具执行、流式输出）
      return { resultText: '好了', toolCalls: [] };
    });

    await runChatAndPersist({
      agent: { id: 'a1', ownerId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      emit: () => {},
    } as never);

    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock.mock.calls[0][2]).toMatchObject({ id: 'm1', createdAt: t0 });
  });

  it('中断半截路径：同样盖开始时刻', async () => {
    const t0 = Date.now();
    runChatMock.mockImplementation(async () => {
      vi.advanceTimersByTime(30_000);
      throw interruptedError('aborted');
    });

    await runChatAndPersist({
      agent: { id: 'a1', ownerId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      emit: () => {},
    } as never);

    expect(appendMessageMock).toHaveBeenCalledTimes(1);
    expect(appendMessageMock.mock.calls[0][2]).toMatchObject({ id: 'm1', createdAt: t0 });
  });
});

describe('runChatAndPersist - 回合结果回报（供定时任务 lastRun 判成/败/中止）', () => {
  beforeEach(() => {
    runChatMock.mockReset();
    appendMessageMock.mockReset().mockResolvedValue(undefined);
    captureMock.mockReset();
  });

  async function outcome(setup: () => void) {
    setup();
    return runChatAndPersist({
      agent: { id: 'a1', ownerId: 'o1' },
      conversation: { id: 'c1' },
      messageId: 'm1',
      emit: () => {},
    } as never);
  }

  it('正常跑完 → ok', async () => {
    const r = await outcome(() =>
      runChatMock.mockResolvedValue({ resultText: '好了', toolCalls: [] }),
    );
    expect(r).toBe('ok');
  });

  it('用户 abort（reason=aborted）→ aborted（非 ok 非 error）', async () => {
    const r = await outcome(() => runChatMock.mockRejectedValue(interruptedError('aborted')));
    expect(r).toBe('aborted');
  });

  it('上游挂死（upstream_error）→ error', async () => {
    const r = await outcome(() => runChatMock.mockRejectedValue(interruptedError('upstream_error')));
    expect(r).toBe('error');
  });

  it('真错误（无 interruptedTurn）→ error', async () => {
    const r = await outcome(() => runChatMock.mockRejectedValue(new Error('backend 挂了')));
    expect(r).toBe('error');
  });
});
