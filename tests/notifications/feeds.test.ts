/**
 * 系统信号四类源接入单测（S14 · G106）——平台状态映射、写盘失败、调度停摆看门狗。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlatformStatus } from '../../shared/platform/message';
import {
  feedPlatformStatus,
  feedWriteFailure,
  startSchedulerWatchdog,
  stopSchedulerWatchdog,
} from '../../electron/main/notifications/feeds';
import {
  listSystemSignals,
  setSystemSignalBroadcaster,
  __resetSystemSignalsForTest,
} from '../../electron/main/notifications/systemSignals';

beforeEach(() => {
  __resetSystemSignalsForTest();
  setSystemSignalBroadcaster(() => {});
});
afterEach(() => stopSchedulerWatchdog());

const st = (state: PlatformStatus['state'], error?: string): PlatformStatus => ({
  platform: 'feishu',
  state,
  error,
});

describe('feedPlatformStatus', () => {
  // 回归：disconnected 由「用户停用平台」产生（从没启用过 Discord 也会上报它），
  // 不得升任何系统信号——原实现把它当掉线误报（2026-07-14 用户报障）
  it('disconnected（未启用/停用）不升任何信号', () => {
    feedPlatformStatus(st('disconnected'));
    expect(listSystemSignals()).toEqual([]);
  });

  it('credential-error → 凭据过期信号（带 detail）', () => {
    feedPlatformStatus(st('credential-error', 'token expired'));
    const sig = listSystemSignals()[0];
    expect(sig.kind).toBe('credential-expired');
    expect(sig.detail).toBe('token expired');
  });

  it('凭据恢复 connected → 清', () => {
    feedPlatformStatus(st('credential-error', 'token expired'));
    feedPlatformStatus(st('connected'));
    expect(listSystemSignals()).toEqual([]);
  });

  it('凭据出错后停用平台（disconnected）→ 同样清', () => {
    feedPlatformStatus(st('credential-error', 'token expired'));
    feedPlatformStatus(st('disconnected'));
    expect(listSystemSignals()).toEqual([]);
  });
});

describe('feedWriteFailure', () => {
  it('升起单条 write-failed（critical），detail 记路径+原因', () => {
    feedWriteFailure('/x/a.json', new Error('ENOSPC'));
    const sig = listSystemSignals()[0];
    expect(sig).toMatchObject({ id: 'write-failed', kind: 'write-failed', severity: 'critical' });
    expect(sig.detail).toContain('ENOSPC');
  });
});

describe('startSchedulerWatchdog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('心跳变陈 → 升 scheduler-stalled；心跳恢复 → 清', () => {
    let health = { started: true, lastTickAt: Date.now() };
    startSchedulerWatchdog(() => health);

    // 心跳新鲜：首次 check 不报
    vi.advanceTimersByTime(60_000);
    expect(listSystemSignals()).toEqual([]);

    // 让心跳陈旧（>90s）→ 下个 check 升信号
    health = { started: true, lastTickAt: Date.now() - 120_000 };
    vi.advanceTimersByTime(60_000);
    expect(listSystemSignals().map((s) => s.kind)).toEqual(['scheduler-stalled']);

    // 心跳恢复 → 清
    health = { started: true, lastTickAt: Date.now() };
    vi.advanceTimersByTime(60_000);
    expect(listSystemSignals()).toEqual([]);
  });

  it('未启动（started=false）不误报', () => {
    startSchedulerWatchdog(() => ({ started: false, lastTickAt: 0 }));
    vi.advanceTimersByTime(60_000);
    expect(listSystemSignals()).toEqual([]);
  });
});

describe('feedTrashedProfiles（旧撤销缺陷误删的档案仍在回收站）', () => {
  it('有档案 → 升 warning 信号，count 与 detail 列出路径', async () => {
    const { feedTrashedProfiles } = await import('../../electron/main/notifications/feeds');
    feedTrashedProfiles(['2026-07-20/agents/twin/self.md', '2026-07-20/projects/p1/profile.md']);
    const sig = listSystemSignals()[0];
    expect(sig?.kind).toBe('trashed-profile-found');
    expect(sig?.severity).toBe('warning');
    expect(sig?.params?.count).toBe(2);
    expect(sig?.detail).toContain('agents/twin/self.md');
  });

  it('空列表 → 不升信号', async () => {
    const { feedTrashedProfiles } = await import('../../electron/main/notifications/feeds');
    feedTrashedProfiles([]);
    expect(listSystemSignals()).toEqual([]);
  });
});
