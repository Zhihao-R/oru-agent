/**
 * DebugLogger.beginRound 换日触发留存清理：
 * 同一天多轮只扫一次，跨天再扫；关闭态（enabled=false）也扫——旧日志照样要过期。
 *
 * retention 模块被 mock，本文件不落盘；留存选择/删除本身在 retention.test.ts。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

import { sweepExpiredDebugDays } from '../../electron/main/debug/retention';
import { DebugLogger, type RoundMeta } from '../../electron/main/debug/logger';

vi.mock('../../electron/main/debug/retention', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../electron/main/debug/retention')>();
  return {
    ...mod,
    sweepExpiredDebugDays: vi.fn(async () => {}),
  } satisfies typeof mod;
});

describe('DebugLogger.beginRound 换日触发清理', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一天多轮只扫一次，跨天再扫一次；关闭态也扫', () => {
    const sweep = vi.mocked(sweepExpiredDebugDays);
    sweep.mockClear();

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 28, 12, 0, 0));

    const logger = new DebugLogger();
    // enabled=false：beginRound 返回 NoOp、不建 writer 不落盘，但留存清理照样触发
    const meta: RoundMeta = {
      roundId: 'r1',
      conversationId: 'c1',
      ownerId: 'local-user',
      source: 'main_chat',
      userText: 'hi',
    };
    logger.beginRound({ ...meta });
    logger.beginRound({ ...meta, roundId: 'r2' });
    expect(sweep).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(2026, 6, 29, 0, 30, 0));
    logger.beginRound({ ...meta, roundId: 'r3' });
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
