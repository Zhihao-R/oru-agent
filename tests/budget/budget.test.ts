/**
 * 预算两级线主进程单测（S15 · G111）——状态读取、无人值守闸、信号 raise/clear 生命周期与转移。
 * 账本与设置 mock 掉（避免拉起 electron / 真实盘）；系统信号注册表用真的，经 listSystemSignals 断言。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Settings } from '../../shared/types';
import type { UsageLedgerFile } from '../../shared/usage/types';
import { localDayKey } from '../../shared/usage/summarize';

const { getSettingsMock, getUsageDaysMock } = vi.hoisted(() => ({
  getSettingsMock: vi.fn<[], Promise<Settings>>(),
  getUsageDaysMock: vi.fn<[string?], Promise<UsageLedgerFile['days']>>(),
}));

vi.mock('../../electron/main/projects/store', () => ({ getSettings: getSettingsMock }));
vi.mock('../../electron/main/usage/ledger', () => ({ getUsageDays: getUsageDaysMock }));

import { getBudgetStatus, refreshBudgetSignals } from '../../electron/main/budget/budget';
import {
  listSystemSignals,
  setSystemSignalBroadcaster,
  __resetSystemSignalsForTest,
} from '../../electron/main/notifications/systemSignals';

const NOW = new Date(2026, 6, 11, 12, 0, 0).getTime();

/** 只有 budget 字段被读，其余给足 satisfies Settings 的必填项。 */
function settings(budget: Settings['budget']): Settings {
  return {
    theme: 'system',
    colorScheme: 'terracotta',
    manualApiKey: null,
    providers: [],
    models: [],
    modelAssignments: {
      twinMain: null,
      twinBackground: null,
      memoryDream: null,
      subagentCoder: null,
      conversationSummary: null,
      conversationTitle: null,
      twinSubagent: null,
      asideComment: null,
      loopReviewer: null,
      memoryRecall: null,
    },
    budget,
  } satisfies Settings;
}

/** 今天一笔 spent token（input 全给），落在滚动窗口内。 */
function daysWithSpent(spent: number): UsageLedgerFile['days'] {
  return { [localDayKey(NOW)]: { twinMain: { inputTokens: spent, outputTokens: 0, calls: 1 } } };
}

const ids = () => listSystemSignals().map((s) => s.id);

beforeEach(() => {
  __resetSystemSignalsForTest();
  setSystemSignalBroadcaster(() => {});
  getSettingsMock.mockReset();
  getUsageDaysMock.mockReset();
});

describe('getBudgetStatus', () => {
  it('关闭时 off，不看用量多少', async () => {
    getSettingsMock.mockResolvedValue(settings({ enabled: false, hardLimitTokens: 1000, softRatio: 0.8 }));
    getUsageDaysMock.mockResolvedValue(daysWithSpent(99999));
    expect((await getBudgetStatus('local-user', NOW)).level).toBe('off');
  });

  it('窗口内已用对上两级线', async () => {
    getSettingsMock.mockResolvedValue(settings({ enabled: true, hardLimitTokens: 1000, softRatio: 0.8 }));
    getUsageDaysMock.mockResolvedValue(daysWithSpent(850));
    expect(await getBudgetStatus('local-user', NOW)).toMatchObject({ level: 'soft', spentTokens: 850 });
  });

  it('窗口外的用量不计入（31 天前）', async () => {
    getSettingsMock.mockResolvedValue(settings({ enabled: true, hardLimitTokens: 1000, softRatio: 0.8 }));
    const old = NOW - 31 * 24 * 3600_000;
    getUsageDaysMock.mockResolvedValue({ [localDayKey(old)]: { twinMain: { inputTokens: 5000, outputTokens: 0, calls: 1 } } });
    expect((await getBudgetStatus('local-user', NOW)).level).toBe('ok'); // 旧账不算，窗口内为 0
  });
});

describe('refreshBudgetSignals · 信号生命周期', () => {
  beforeEach(() => {
    getSettingsMock.mockResolvedValue(settings({ enabled: true, hardLimitTokens: 1000, softRatio: 0.8 }));
  });

  it('ok → 无信号', async () => {
    getUsageDaysMock.mockResolvedValue(daysWithSpent(100));
    await refreshBudgetSignals('local-user', NOW);
    expect(ids()).toEqual([]);
  });

  it('soft → 升 budget-warning（warning）', async () => {
    getUsageDaysMock.mockResolvedValue(daysWithSpent(850));
    await refreshBudgetSignals('local-user', NOW);
    expect(ids()).toEqual(['budget-warning']);
    expect(listSystemSignals()[0].severity).toBe('warning');
  });

  it('hard → 升 budget-exhausted（critical）并撤掉 warning', async () => {
    getUsageDaysMock.mockResolvedValue(daysWithSpent(1200));
    await refreshBudgetSignals('local-user', NOW);
    expect(ids()).toEqual(['budget-exhausted']);
    expect(listSystemSignals()[0].severity).toBe('critical');
  });

  it('soft→hard→ok 转移各自只留该级信号', async () => {
    getUsageDaysMock.mockResolvedValue(daysWithSpent(850));
    await refreshBudgetSignals('local-user', NOW);
    expect(ids()).toEqual(['budget-warning']);

    getUsageDaysMock.mockResolvedValue(daysWithSpent(1200));
    await refreshBudgetSignals('local-user', NOW);
    expect(ids()).toEqual(['budget-exhausted']); // warning 被撤

    getUsageDaysMock.mockResolvedValue(daysWithSpent(10));
    await refreshBudgetSignals('local-user', NOW);
    expect(ids()).toEqual([]); // 两条都撤
  });
});

describe('fail-open · 读预算失败', () => {
  it('账本读失败 → 不动已在场信号（读不出 ≠ 未耗尽），返回 off 状态', async () => {
    // 先制造一条在场的 exhausted 信号（正常 hard 态）
    getSettingsMock.mockResolvedValue(settings({ enabled: true, hardLimitTokens: 1000, softRatio: 0.8 }));
    getUsageDaysMock.mockResolvedValue(daysWithSpent(1200));
    await refreshBudgetSignals('local-user', NOW);
    expect(ids()).toEqual(['budget-exhausted']);

    // 下一次账本读抛错 → 信号原样保留（不被 fail-open 撤掉），状态回落 off
    getUsageDaysMock.mockRejectedValueOnce(new Error('boom'));
    const status = await refreshBudgetSignals('local-user', NOW);
    expect(status.level).toBe('off');
    expect(ids()).toEqual(['budget-exhausted']);
  });
});
