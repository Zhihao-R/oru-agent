/**
 * 已结束任务的分组口径（endedKind）：「已触发 / 未能触发」二分 + 未能触发的原因细分。
 *
 * 关键口径（tech §E）：已触发 = lastRun 非空（含触发后执行失败的）；**不能用 runCount**——手动
 * 「立即执行」走 countsAsRun:false 只落 lastRun 不进 runCount，用 runCount 会把手动跑过的误判成未触发。
 */
import { describe, it, expect } from 'vitest';
import { endedKind } from '@/lib/scheduledTaskFormat';
import type { ScheduledTask } from '@shared/types';

const run = (over: Partial<NonNullable<ScheduledTask['lastRun']>> = {}): ScheduledTask['lastRun'] => ({
  at: 1, status: 'ok', late: false, ...over,
});

describe('endedKind', () => {
  it('lastRun 非空 → triggered（已触发，含执行失败/中止的）', () => {
    expect(endedKind({ lastRun: run() })).toBe('triggered');
    expect(endedKind({ lastRun: run({ status: 'error' }) })).toBe('triggered'); // 触发了但执行失败仍属已触发
    expect(endedKind({ lastRun: run({ status: 'aborted' }) })).toBe('triggered'); // 触发了但被按停仍属已触发
  });
  it('lastRun 为空、未被忽略 → expired（设定时间已过，未执行）', () => {
    expect(endedKind({})).toBe('expired');
  });
  it('lastRun 为空、dismissed:true → dismissed（你已忽略）', () => {
    expect(endedKind({ dismissed: true })).toBe('dismissed');
  });
  it('防 runCount 误判回归：手动执行过的 once（runCount=0 但 lastRun 有）→ triggered', () => {
    expect(endedKind({ runCount: 0, lastRun: run() })).toBe('triggered');
  });
});
