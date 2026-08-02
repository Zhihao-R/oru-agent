/**
 * 两阶段整理内核（S16 G62/G63）
 *
 * 一句话：上下文用量到真实窗口一半就整理，分两阶段无损先行——先把折叠窗外的老工具回执折叠成
 * 占位（无损、不调 LLM），折叠后重估、能打住就不动有损的摘要；折叠打不住才进第二阶段摘要。
 *
 * 三个调用点共用本内核（回合入口 / 续发检查点 / overflow 被动兜底），只有「生效方式」不同。
 * compress.ts 降为本内核的第二阶段。
 *
 * 设计见 docs/tech/2026-07-11-s16-backend续发钩子与整理时机实施方案.md §3.4/§4/§5。
 */
import type { ChatMessage } from '@shared/types';
import { estimateHistoryTokens, estimateTokens } from './tokenEstimate';
import { applyFoldingByWatermark, computeFoldWatermark } from './applyTier1Folding';
import { compressIfNeeded, PostCompressOverflowError } from './compress';
import { invalidatePriorReads } from '../conversationFileState';

/**
 * 整理水位 = 真窗过半（G62）。既是触发线也是整理后的装载目标（compress 的 selectN / 终校验对齐到它）。
 * 触发线与装载目标同值不产生抖动：整理后视图（摘要卡＋保留段）远低于水位，天然滞回。
 * effectiveWindow(×0.8「留输出空间」) 已退役——50% 水位天然留一半余量，输出预留被包含。
 */
export function organizeThreshold(contextWindow: number): number {
  return Math.floor(contextWindow / 2);
}

export type OrganizeResult = {
  /** 整理后视图（折叠推进和/或摘要卡＋摘要保留段）——直接塞 ConversationInput.history */
  trimmedHistory: ChatMessage[];
  /** 仅进入摘要阶段才产卡；纯折叠无损、不落卡 */
  notificationMessage?: ChatMessage;
  /** 新折叠水印（消息 id），调用方持久化到 Conversation.foldedBeforeMessageId；undefined=无可折、清空 */
  foldedBefore?: string;
  /** 'summary' 含「先折叠再摘要」的情形 */
  stage: 'fold' | 'summary';
};

export type OrganizeArgs = {
  conversationId: string;
  /** readHistoryForLLM 视图（已按现有水印折叠） */
  history: ChatMessage[];
  systemContext: string;
  /** 真窗，不再预乘 0.8 */
  contextWindow: number;
  /** force=true：被动兜底（overflow），不看触发线、必整理 */
  force?: boolean;
  /**
   * 续发检查点用（S16 §6）：本轮 in-flight 产出（assistant 文本 + 工具回执）的 token 估算。
   * 水位判定 = systemContext + seed + extraTokens；摘要装载目标相应扣掉 extraTokens 给 in-flight 留位。
   * 回合入口整理不传（此刻无 in-flight）。
   */
  extraTokens?: number;
  ownerId?: string;
  agentId?: string;
  agentName?: string;
};

/**
 * 返回 null 仅表示「无事可做」（未到水位且非 force，或连折叠都推进不了且摘要也没做）。
 * 折叠可做而摘要不可做（user 轮数不足，或 force 下同）时返回折叠所得——stage:'fold' 且可能仍超
 * 水位，调用方照发、真撞墙由被动兜底接原错误。
 */
export async function organizeContext(args: OrganizeArgs): Promise<OrganizeResult | null> {
  const threshold = organizeThreshold(args.contextWindow);
  const extra = args.extraTokens ?? 0;
  // 水位判定含 in-flight 产出（续发检查点）；回合入口 extra=0
  const estimate = (h: ChatMessage[]) =>
    estimateTokens(args.systemContext) + estimateHistoryTokens(h) + extra;

  // 1. 未到水位且非 force → 无事可做
  if (!args.force && estimate(args.history) < threshold) return null;

  // 2. 阶段一·折叠：水印推进到当前折叠窗边界，重建视图、重估
  const foldedBefore = computeFoldWatermark(args.history);
  const folded = applyFoldingByWatermark(args.history, foldedBefore);
  // 真有内容被折走 → 上下文代际 +1：read_file 的 dedup 据此知道「上次读到的内容已离场」，
  // 下次重读要给全文而不是回一句"参考上次读取的内容"（conversationFileState）。
  // 逐条比引用而不是比数组：applyFoldingByWatermark 恒返回新数组，没折到的消息保持原引用。
  if (folded.some((m, i) => m !== args.history[i])) invalidatePriorReads(args.conversationId);
  // 非 force：折叠即达标 → 到此为止，不调摘要 LLM、不落卡
  if (!args.force && estimate(folded) <= threshold) {
    return { trimmedHistory: folded, foldedBefore, stage: 'fold' };
  }

  // 3. 阶段二·摘要：折叠后仍超水位（或 force）→ 在折叠后视图上走 compressIfNeeded。
  // 摘要装载目标扣掉 extra，给 in-flight 留位（seed + in-flight 才是真实发送量）。
  // 单条消息就超水位（如末轮 user 巨大）时 compress 抛 PostCompressOverflowError——整理无能为力，
  // 按设计意图「照发、真撞墙由被动兜底接原错误」处理：吞掉该异常、退回折叠所得（不把异常抛给
  // 续发检查点炸整回合）。真发送若撞窗，由 streamOnce 后的 overflow 被动兜底 / 外层兜底接手。
  let compressed;
  try {
    compressed = await compressIfNeeded({
      conversationId: args.conversationId,
      history: folded,
      systemContext: args.systemContext,
      threshold: Math.max(1, threshold - extra),
      force: args.force,
      ownerId: args.ownerId,
      agentId: args.agentId,
      agentName: args.agentName,
    });
  } catch (e) {
    if (e instanceof PostCompressOverflowError) {
      return foldedBefore ? { trimmedHistory: folded, foldedBefore, stage: 'fold' } : null;
    }
    throw e;
  }
  if (!compressed) {
    // 摘要不可做（user 轮数不足 / 无可压）：折叠可做 → 返回折叠所得（可能仍超水位，调用方照发）；
    // 无可折（含 force 且无可折）→ null，交调用方外层 dropOldestTurns 硬丢兜底。
    return foldedBefore ? { trimmedHistory: folded, foldedBefore, stage: 'fold' } : null;
  }
  // 摘要真把老消息压掉了——同样让此前的读取失效。
  // （runner 的 dropOldestTurns 硬丢兜底走不到这里——它的前提正是本函数返回 null——
  //  那条路在 runner.ts 自增点自行推进代际。）
  invalidatePriorReads(args.conversationId);
  // 摘要吞掉水印所指消息时，把水印重钉到新视图内的折叠边界（无可折内容则清空字段）
  return {
    trimmedHistory: compressed.trimmedHistory,
    notificationMessage: compressed.notificationMessage,
    foldedBefore: computeFoldWatermark(compressed.trimmedHistory),
    stage: 'summary',
  };
}
