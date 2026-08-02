/**
 * 全局预算两级线（理想架构 S15 · G111）——**先只做提醒，不硬截断**（PM 2026-07-11 拍板）。
 *
 * 用量账本（S13）记「花了多少」，本模块把它对上「预算多少」，划出两级提醒线：
 *   软警戒线 → 接近预算：发系统信号进通知中心（S14），事前警戒；
 *   硬上限   → 已达预算：发一条更醒目的信号（critical）——同样只是提醒，**不停任何路径**。
 *
 * 理想态是「到硬上限时无人值守路径暂停」，但当下 PM 拍板先只提醒不截断（见 model-backend.html 标注 +
 * 台账 G111 open 行）。故本模块只算状态、升降信号；不再有 isUnattendedHalted 那类拦截入口。
 *
 * 窗口 = 滚动 30 天（PM 2026-07-11 拍板，对齐账本粗聚合、不与自然月账单强绑）。判定纯函数在
 * @shared/budget/evaluate，主进程与渲染层共用。两条 budget-* 信号的生命周期由本模块独占
 * （applySignals raise/clear），别处不碰。ownerId 默认当前用户，与账本 recordUsage 的记账口径一致。
 */
import type { BudgetStatus } from '@shared/budget/types';
import { evaluateBudget } from '@shared/budget/evaluate';
import { summarizeUsage } from '@shared/usage/summarize';
import { getUsageDays } from '../usage/ledger';
import { getSettings } from '../projects/store';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { raiseSystemSignal, clearSystemSignal } from '../notifications/systemSignals';

/** 滚动窗口：近 30 天（含今天）。 */
const WINDOW_MS = 30 * 24 * 3600_000;

const WARN_ID = 'budget-warning';
const EXHAUSTED_ID = 'budget-exhausted';

/** 未设限的空状态——预算读不出时的 fail-open 回落（仅用于放行判定，不据此改信号）。 */
const OFF_STATUS: BudgetStatus = { level: 'off', spentTokens: 0, softLimitTokens: 0, hardLimitTokens: 0 };

/** 读当前预算状态：窗口内已用 token 对上配置。now 可注入便于测试。读失败原样抛给调用方处置。 */
export async function getBudgetStatus(
  ownerId: string = getCurrentOwnerId(),
  now: number = Date.now(),
): Promise<BudgetStatus> {
  const settings = await getSettings();
  const days = await getUsageDays(ownerId);
  const sum = summarizeUsage(days, { from: now - WINDOW_MS });
  const spent = sum.total.inputTokens + sum.total.outputTokens;
  return evaluateBudget(spent, settings.budget);
}

/**
 * 按当前状态升起 / 消解两条预算信号——本模块独占其生命周期。信号不带随用量抖动的数字
 * （避免过软线后每次 flush 都刷屏），只当路标，具体账本去设置页「用量」看。
 */
function applySignals(status: BudgetStatus): void {
  if (status.level === 'hard') {
    clearSystemSignal(WARN_ID);
    raiseSystemSignal({ id: EXHAUSTED_ID, kind: 'budget-exhausted', severity: 'critical' });
  } else if (status.level === 'soft') {
    clearSystemSignal(EXHAUSTED_ID);
    raiseSystemSignal({ id: WARN_ID, kind: 'budget-warning', severity: 'warning' });
  } else {
    clearSystemSignal(WARN_ID);
    clearSystemSignal(EXHAUSTED_ID);
  }
}

/**
 * 重算并同步信号（账本 flush 后驱动，事前警戒）。返回状态供调用方复用。
 * fail-open：读设置 / 账本失败绝不拦主链路（同账本 recordUsage 精神），且**不动已在场的预算信号**
 * ——「读不出」不等于「未耗尽」，不能把已升起的 exhausted 悄悄撤掉误导用户。
 */
export async function refreshBudgetSignals(
  ownerId: string = getCurrentOwnerId(),
  now: number = Date.now(),
): Promise<BudgetStatus> {
  let status: BudgetStatus;
  try {
    status = await getBudgetStatus(ownerId, now);
  } catch (e) {
    console.warn('[budget] 读预算状态失败，按未设限放行、不动信号（fail-open）:', e instanceof Error ? e.message : e);
    return OFF_STATUS;
  }
  applySignals(status);
  return status;
}
