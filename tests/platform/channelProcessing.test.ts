/**
 * 「处理中」表情登记表（S10 · §6 / review C1·m1）——登记/清除的单一收口。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  registerProcessing,
  clearProcessing,
  clearProcessingForItems,
} from '../../electron/main/platform/channelProcessing';
import type { TriggerOrigin } from '@shared/types';

function origin(chatId: string, mid = 'm'): TriggerOrigin {
  return { platform: 'feishu', chatId, platformMessageId: mid };
}

describe('channelProcessing', () => {
  it('登记后 clearProcessing 调清除闭包一次；再清幂等（不重复调）', async () => {
    const o = origin('c1');
    const clear = vi.fn().mockResolvedValue(undefined);
    registerProcessing(o, clear);
    await clearProcessing(o);
    await clearProcessing(o); // 幂等
    expect(clear).toHaveBeenCalledTimes(1);
  });

  it('未登记 → clearProcessing no-op（不抛）', async () => {
    await expect(clearProcessing(origin('nope'))).resolves.toBeUndefined();
  });

  it('清除闭包抛错被吞（表情是非承重副作用，不崩调用方）', async () => {
    const o = origin('c2');
    registerProcessing(o, vi.fn().mockRejectedValue(new Error('平台 API 挂了')));
    await expect(clearProcessing(o)).resolves.toBeUndefined();
  });

  it('clearProcessingForItems：逐条清有 origin 的、跳过无 origin 的', async () => {
    const a = origin('ca');
    const b = origin('cb');
    const clearA = vi.fn().mockResolvedValue(undefined);
    const clearB = vi.fn().mockResolvedValue(undefined);
    registerProcessing(a, clearA);
    registerProcessing(b, clearB);
    clearProcessingForItems([{ origin: a }, {}, { origin: b }]);
    // fire-and-forget，等微任务清空
    await Promise.resolve();
    await Promise.resolve();
    expect(clearA).toHaveBeenCalledTimes(1);
    expect(clearB).toHaveBeenCalledTimes(1);
  });

  it('按 origin 精确：同 chat 不同 platformMessageId 互不误清', async () => {
    const m1 = origin('cc', 'msg1');
    const m2 = origin('cc', 'msg2');
    const clear1 = vi.fn().mockResolvedValue(undefined);
    const clear2 = vi.fn().mockResolvedValue(undefined);
    registerProcessing(m1, clear1);
    registerProcessing(m2, clear2);
    await clearProcessing(m1);
    expect(clear1).toHaveBeenCalledTimes(1);
    expect(clear2).not.toHaveBeenCalled(); // 同 chat 还在排队的另一条表情不被误清
  });
});
