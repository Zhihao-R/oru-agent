/**
 * 断路器跳闸编排（G01/G04）——把「检测（circuitBreaker）＋信箱（pendingCircuitBreaker）＋弹卡」
 * 缝在一起，供 executeAgentTool 在每次工具执行前调一次。
 *
 * 一个回合里多个工具并发跑（roundTrip Promise.all）同时跳闸时，只弹一张卡：按对话把跳闸决定去重，
 * 并发的其余工具等同一份决定。用户「继续放行」→ reset 清零、全部放行接着跑；「停止」→ 全部当停。
 */
import type { ToolContext } from '@shared/agent/backend';
import { newBreakerId } from '@shared/ids';
import { noteToolCall, noteToolResult, evaluateTrip, resetBreaker } from './circuitBreaker';
import {
  awaitBreakerDecision,
  settleBreaker,
  abortBreaker,
  type BreakerDecision,
} from '../proposals/pendingCircuitBreaker';

export { noteToolResult, settleBreaker };

/** 同对话在飞的跳闸决定——去重并发工具的重复弹卡。 */
const inflight = new Map<string, Promise<BreakerDecision>>();

/**
 * 工具执行前的断路器闸。记这次调用、判是否跳闸；跳闸则弹卡阻塞等用户。
 * 返回 'proceed'（放行，含未跳闸/用户继续）或 'stopped'（用户选择停止）。
 */
export async function guardToolCall(ctx: ToolContext, now: number): Promise<'proceed' | 'stopped'> {
  noteToolCall(ctx.conversationId, now);
  const reason = evaluateTrip(ctx.conversationId);
  if (!reason) return 'proceed';
  // 无 UI 弹不了卡（背景 query / 无 onCircuitBreak）→ 不阻塞，交给看门狗 / 预算线兜底。
  if (!ctx.onCircuitBreak) return 'proceed';

  const decision = await tripAndAwait(ctx, reason);
  if (decision === 'resume') {
    resetBreaker(ctx.conversationId);
    return 'proceed';
  }
  return 'stopped';
}

function tripAndAwait(
  ctx: ToolContext,
  reason: 'consecutive-failures' | 'high-frequency',
): Promise<BreakerDecision> {
  const convId = ctx.conversationId;
  let shared = inflight.get(convId);
  if (!shared) {
    shared = doTrip(ctx, reason).finally(() => inflight.delete(convId));
    inflight.set(convId, shared);
  }
  return shared;
}

async function doTrip(
  ctx: ToolContext,
  reason: 'consecutive-failures' | 'high-frequency',
): Promise<BreakerDecision> {
  const breakerId = newBreakerId();
  // 先挂 waiter 再 emit 卡（仿 askUserChoice）：确保 waiter 早于任何 settle 就位。
  const pending = awaitBreakerDecision(breakerId, ctx.abortSignal);
  try {
    await ctx.onCircuitBreak!({ breakerId, conversationId: ctx.conversationId, reason });
  } catch {
    abortBreaker(breakerId);
    await pending.catch(() => {});
    return 'stop'; // 弹卡失败 → 保守停下（宁可停，不放任失控循环）
  }
  try {
    return await pending;
  } catch {
    return 'stop'; // abort（用户刹车 / 回合报错）→ 当停止
  }
}
