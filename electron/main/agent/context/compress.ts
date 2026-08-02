/**
 * 对话压缩
 *
 * 保留段策略（PRD §6.2）：固定最近 N=5 轮（曾是"动态 token 预算（60%）"，已废弃）。
 * 两阶段：先用保守摘要预算（SUMMARY_TOKEN_BUDGET）递减 N=5→1 选出最终 n，再按该 n 的
 * 范围调摘要 LLM 并用真实 token 终校验——保证摘要覆盖范围与 compressedMessageIds 恒等。
 * N=1 仍超 / user 数不足 N → 抛 ContextOverflowError（runner 走最外层 throw）。
 *
 * 主路径：用 conversationSummary backend 把老对话压成摘要，发给 LLM 的 history 替换为
 *   "最新一条 context-compressed 卡 + 最近 N 轮"
 * 失败回退：摘要 backend 调用失败 / 超时 / 输出不合法 → 走硬丢老消息的兜底路径。
 *
 * S16 起本函数是两阶段整理的第二阶段（有损摘要）——由 organizeContext 在折叠打不住时调用，
 * threshold 传 organizeThreshold(window)=floor(window/2)（既是触发线也是装载目标）。
 * 被动兜底（force=true）仍直接调本函数。
 */
import type { ChatMessage, ContextCompressedPayload } from '@shared/types';
import { newMessageId } from '@shared/ids';
import { getBackendFor, runOneShotWithTimeout } from '../backends';
import { instrumentOneShot } from '../../debug/instrument';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';
import {
  estimateHistoryTokens,
  estimateMessageTokens,
  estimateTokens,
} from './tokenEstimate';
import { buildSummaryPrompt } from './summaryPrompt';

/**
 * 摘要 oneShot 调用超时——实测 69 条 / 12.5 万字符 prompt 在 Claude 远端跑 ~46s 才完成,
 * 30s 容易触发误判 fallback。调到 90s 给慢路径足够余量;真挂死再走兜底。
 */
const SUMMARY_TIMEOUT_MS = 90_000;
/**
 * 主路径保留最近 N 轮；一个 user + 紧跟到下一个 user（不含）之间的所有消息算一轮。
 * 递减兜底跌到 1 仍超 → 抛 overflow。
 * 硬编码常量；未来需求出现再升 Settings。
 */
const KEEP_RECENT_ROUNDS = 5;

/** 手动压缩的「对话还太短」判定与上面的边界同源——导出常量防两份数字漂移。 */
export { KEEP_RECENT_ROUNDS };

/**
 * 第一阶段选 n 时给摘要占位的保守 token 预算。
 *
 * 取值依据：summaryPrompt 要求摘要"长度不超过 1500 字"（MAX_SUMMARY_LENGTH），
 * 按 tokenEstimate 的 CJK 最坏口径 1.5 token/字 → 1500 × 1.5 = 2250。
 * 宁可高估不低估——真实长度第二阶段用实际 summaryText 终校验。
 */
const SUMMARY_TOKEN_BUDGET = 2250;

/**
 * 永不被摘要或 Tier 1 折叠吞掉的 ChatMessageKind 白名单。
 *
 * **只有 plugin-activate**——runner 每轮要扫 chat 流重建 activatedPlugins Set，
 * 这个 chip 一旦消失，重建就拿不到激活的 pluginId，分身得反复 activate_plugin 浪费轮次。
 *
 * 其余 6 个 skill chip 是"给用户看的历史"，靠 JSONL 持久化即可，没必要不压缩占 token。
 *
 * 实施细节：白名单消息从"被压缩段"抽出，按原时序紧跟 summaryMarker（idx=0）之后插入。
 * compressedMessageIds 排除白名单——避免 trimmedHistory 与 compressedMessageIds 重复
 * 让前端按 id 反查时双显。
 *
 * applyTier1Folding 复用此常量（import 自本文件），避免维护两份。
 */
export const NEVER_COMPRESS_KINDS: ReadonlySet<NonNullable<ChatMessage['kind']>> = new Set([
  'plugin-activate',
]);

export type CompressArgs = {
  conversationId: string;
  /**
   * 输入 history 必须由 readHistoryForLLM 提供——即"从最后一个 context-compressed marker
   * 起的切片"。所以本函数内部：
   * - findLastContextCompressedIdx 永远找到 idx=0（marker 在首位）或 -1（无 marker）
   * - userIdxs 只计入 marker 后的 user，不会出现"5 轮跨越 marker"导致 startToCompress 为空
   * - previousSummary 直接从 history[0] 读，递增式摘要链正常工作
   */
  history: ChatMessage[];
  systemContext: string;
  /**
   * 整理阈值（token 预算）——既是触发线也是装载目标（selectN / 终校验对齐到它）。
   * S16 起由 organizeContext 传 organizeThreshold(window)=floor(window/2)；
   * effectiveWindow(×0.8) 已退役，不再在此二次打折。
   */
  threshold: number;
  /** force=true 时不看阈值直接压（被动兜底） */
  force?: boolean;
  /** 调试日志身份——runner 传入；缺省时回落（测试调用不关心） */
  ownerId?: string;
  agentId?: string;
  agentName?: string;
};

export type CompressResult = {
  /** 替代 history 给 backend 的"摘要 + 最近 N 轮"——直接塞 ConversationInput.history */
  trimmedHistory: ChatMessage[];
  /** 落盘到 JSONL 的通知卡消息（runner 持久化时用） */
  notificationMessage: ChatMessage;
  /** true 表示摘要失败回退到硬丢；前端文案改 */
  fallback: boolean;
};

/**
 * 压缩后仍超装载目标（threshold）的极端情况——抛此错；runner 走最外层 throw 流（用户看错误对话框）。
 * S16 起 organizeContext 在续发检查点会捕获本异常、退回折叠所得（照发、真撞墙交被动兜底）。
 * Message 用 'context window' 关键词让 overflow 检测器也识别一致（虽然 runner 当前不再 retry）。
 */
class PostCompressOverflowError extends Error {
  constructor(detail: string) {
    super(`context window exceeded after compression: ${detail}`);
    this.name = 'PostCompressOverflowError';
  }
}

/**
 * 估算当前 prefix 是否需要压缩；不需要返回 null。
 * 需要时执行压缩并返回 trimmedHistory + 通知卡 ChatMessage。
 *
 * 抛 PostCompressOverflowError 的两种情况（PRD §6.2 + tech doc §2.7）：
 *   - history user 数 < N
 *   - N 递减到 1 后仍超装载目标（threshold）
 */
export async function compressIfNeeded(args: CompressArgs): Promise<CompressResult | null> {
  const sysTokens = estimateTokens(args.systemContext);
  const histTokens = estimateHistoryTokens(args.history);
  const total = sysTokens + histTokens;
  const threshold = args.threshold;

  if (!args.force && total < threshold) {
    return null;
  }

  // 找出"已有的最新 context-compressed 卡"——递增式摘要的起点
  const lastCompressedIdx = findLastContextCompressedIdx(args.history);
  // 运行时契约校验：入参 history 必须来自 readHistoryForLLM——marker 至多一个、且在 idx=0。
  // 该契约现由 readHistoryForLLM 结构性保证（其 tail 排除全部 context-compressed kind，
  // 旧卡绝不漏入视图中段，见 store.ts:readHistoryForLLM 注释与 G134），此处 warn 保留为廉价
  // 防御——正常路径可证不触发；若触发说明调用方绕过了 readHistoryForLLM 传了全量 history。
  if (lastCompressedIdx > 0) {
    console.warn(
      `[compress] 入参 history 含中段 marker（idx=${lastCompressedIdx}，应为 0 或 -1）——` +
        `调用方未经 readHistoryForLLM 切片，marker 之前内容可能漏发给 LLM`,
    );
  }
  const previousSummary =
    lastCompressedIdx >= 0
      ? args.history[lastCompressedIdx].contextCompressed?.summaryText ?? ''
      : '';

  // 收集所有 user 消息索引——按"最近 N 个 user 起"切保留段
  const userIdxs = findAllUserIdxs(args.history);

  // 边界：user 数不足 N → 不压（返回 null）。
  // 触发场景:小对话单条大消息（属第 4 节工具源头落盘范畴）。
  // 这里**不抛错**让 runner 走原 dropOldestTurns 硬丢兜底——它能丢掉一两个 user 救一些场景；
  // 真救不回还是会撞 backend overflow，由 runner 走 throw e 出去（避免压缩抛错让兜底死代码）。
  if (userIdxs.length < KEEP_RECENT_ROUNDS) {
    return null;
  }

  // 按 N=5 切 startToCompress / startKeepFromIdx
  const startKeepFromIdx = userIdxs[userIdxs.length - KEEP_RECENT_ROUNDS];
  const compressFromIdx = lastCompressedIdx + 1;
  const startToCompress = args.history.slice(compressFromIdx, startKeepFromIdx);

  // 没东西可压（上次摘要后没新轮，或保留段已覆盖到上次摘要后）→ 不做事
  if (startToCompress.length === 0) return null;

  // 摘要 backend：优先 conversationSummary，缺省回退 memoryDream
  const summaryBackend = await pickSummaryBackend();
  if (!summaryBackend) {
    console.warn('[compress] fallback: no summary backend available (conversationSummary / memoryDream 都没配 + 无 OAuth 兜底)');
    return buildFallback(args.conversationId, startToCompress, args.history.slice(startKeepFromIdx));
  }

  // ─── 第一阶段：不调摘要，先用保守预算选出最终 n ──────────────
  // 老 bug：摘要只对 N=5 的 startToCompress 生成，递减后 finalToCompress 范围更大，
  // 多出的轮次进了 compressedMessageIds、从 trimmedHistory 消失、却不在摘要里——内容静默丢失。
  // 现在先选 n 再按该 n 的范围调摘要，摘要范围与 compressedMessageIds 恒等（同一个切片）。
  //
  // Skill 模块 v1：白名单消息每个 n 重新提取（提取范围随 keepFromIdx 变化）。
  // 提取规则：从 toCompress 段里抽出 NEVER_COMPRESS_KINDS 的消息，按原时序排序，
  // 紧跟 summaryMarker 之后插入；这些消息**不进** compressedMessageIds。
  const planFor = (n: number) => {
    const keepFromIdx = userIdxs[userIdxs.length - n];
    const keepMessages = args.history.slice(keepFromIdx);
    const toCompress = args.history.slice(compressFromIdx, keepFromIdx);
    const whitelisted = toCompress.filter((m) => m.kind && NEVER_COMPRESS_KINDS.has(m.kind));
    return {
      keepMessages,
      toCompress,
      whitelisted,
      baseTokens: sysTokens + sumOfMessageTokens(whitelisted) + sumOfMessageTokens(keepMessages),
    };
  };
  /** 从 maxN 递减找第一个"base + 摘要 token 装得下"的 n；全装不下返回 null。 */
  const selectN = (summaryTokens: number, maxN: number): number | null => {
    for (let n = maxN; n >= 1; n -= 1) {
      if (planFor(n).baseTokens + summaryTokens <= threshold) return n;
    }
    return null;
  };

  /** 调一次摘要 LLM；失败（超时 / 出错 / 空输出）返回 null，调用方走 buildFallback。 */
  // 当前任务锚在保留段（不被压缩）——取整个 history 末条 user 消息原文，供摘要卡①小节逐字引用。
  const lastUserIdx = userIdxs[userIdxs.length - 1];
  const currentUserRequest = args.history[lastUserIdx]?.text ?? '';
  const generateSummary = async (toCompress: ChatMessage[]): Promise<string | null> => {
    const prompt = buildSummaryPrompt({ previousSummary, toCompress, currentUserRequest });
    const t0 = Date.now();
    try {
      const summaryText = await instrumentOneShot(
        summaryBackend,
        {
          roundId: newMessageId(),
          conversationId: args.conversationId,
          ownerId: args.ownerId ?? getCurrentOwnerId(),
          agentId: args.agentId,
          agentName: args.agentName,
          source: 'compress',
          userText: prompt,
        },
        () => runOneShotWithTimeout(summaryBackend, { prompt }, SUMMARY_TIMEOUT_MS),
      );
      if (!summaryText || summaryText.trim().length === 0) {
        console.warn(
          `[compress] fallback: summary backend returned empty (${Date.now() - t0}ms, model=${summaryBackend.modelId ?? 'oauth-default'})`,
        );
        return null;
      }
      return summaryText;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = msg.includes('aborted') || msg.includes('AbortError');
      console.warn(
        `[compress] fallback: summary backend ${isTimeout ? 'timeout' : 'error'} (${Date.now() - t0}ms, ` +
        `model=${summaryBackend.modelId ?? 'oauth-default'}, msg=${msg.slice(0, 200)})`,
      );
      return null;
    }
  };

  const firstN = selectN(SUMMARY_TOKEN_BUDGET, KEEP_RECENT_ROUNDS);
  // N=1 仍装不下 → 抛 overflow（runner 走最外层 throw 路径）
  if (firstN === null) {
    throw new PostCompressOverflowError(
      `post-compress overflow at N=1 — single message likely exceeds window`,
    );
  }

  // ─── 第二阶段：按最终 n 调摘要，真实 summaryTokens 终校验 ─────
  // 终校验失败 → 用真实 summaryTokens 重选更小的 n，按新范围重新生成一次
  // （范围变大后旧摘要盖不住多出的轮次，摘要必须与最终压缩范围同源）。
  // LLM 调用上界 2 次；第二次仍超 → buildFallback 硬丢本范围（n 是带正摘要预算选出的，
  // 去掉摘要后必然装下）。
  let n = firstN;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const plan = planFor(n);
    const summaryText = await generateSummary(plan.toCompress);
    if (summaryText === null) {
      // 摘要 LLM 失败 → 按当前 n 的范围硬丢。不能退回 N=5 范围：firstN<5 意味着
      // 5 轮连带摘要预算都装不下，无摘要硬丢 5 轮同样可能超窗、让 runner 再次 overflow；
      // plan 范围是选 n 时验证过装得下的
      return buildFallback(args.conversationId, plan.toCompress, plan.keepMessages);
    }
    const summaryTokens = estimateTokens(summaryText);
    if (plan.baseTokens + summaryTokens <= threshold) {
      const compressedIds = plan.toCompress
        .filter((m) => !(m.kind && NEVER_COMPRESS_KINDS.has(m.kind)))
        .map((m) => m.id);
      const payload: ContextCompressedPayload = {
        compressedMessageIds: compressedIds,
        summaryText,
        summaryModelId: summaryBackend.modelId,
        summaryProviderId: summaryBackend.providerId,
        fallback: false,
      };
      const notificationMessage = makeContextCompressedMessage({
        conversationId: args.conversationId,
        payload,
        text: `对话较长，已自动压缩早期 ${countUserMsgs(plan.toCompress)} 轮内容为摘要`,
      });
      return {
        trimmedHistory: [notificationMessage, ...plan.whitelisted, ...plan.keepMessages],
        notificationMessage,
        fallback: false,
      };
    }
    if (attempt === 2) {
      return buildFallback(args.conversationId, plan.toCompress, plan.keepMessages);
    }
    // 真实摘要超预算：用真实 token 重选（n' < n 必然，更大的 n 只会更超）
    const retryN = selectN(summaryTokens, n - 1);
    if (retryN === null) {
      throw new PostCompressOverflowError(
        `post-compress overflow at N=1 — real summary (${summaryTokens} tokens) exceeds budget at every n`,
      );
    }
    n = retryN;
  }
  // 循环内必然 return / throw；仅为类型完备
  throw new PostCompressOverflowError('unreachable');
}

// ─── 内部 ─────────────────────────────────────────────────────

type SummaryBackend = Awaited<ReturnType<typeof getBackendFor>>;

async function pickSummaryBackend(): Promise<SummaryBackend | null> {
  // 先尝试 conversationSummary；缺省回退 memoryDream
  try {
    return await getBackendFor('conversationSummary');
  } catch {
    // ignore
  }
  try {
    return await getBackendFor('memoryDream');
  } catch {
    return null;
  }
}

function findLastContextCompressedIdx(history: ChatMessage[]): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].kind === 'context-compressed') return i;
  }
  return -1;
}

/** 扫一遍 history 找所有 user 消息的索引，正序返回。 */
function findAllUserIdxs(history: ChatMessage[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < history.length; i += 1) {
    if (history[i].role === 'user') out.push(i);
  }
  return out;
}

/** 数一段消息里有几条 user——"X 轮"的语义按这个算（tech doc §2.5）。 */
function countUserMsgs(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) if (m.role === 'user') n += 1;
  return n;
}

function sumOfMessageTokens(messages: ChatMessage[]): number {
  let t = 0;
  for (const m of messages) t += estimateMessageTokens(m);
  return t;
}

function buildFallback(
  conversationId: string,
  toCompress: ChatMessage[],
  keepMessages: ChatMessage[],
): CompressResult {
  const userRounds = countUserMsgs(toCompress);
  // Skill 模块 v1：fallback 路径也保住白名单消息——激活态重建依赖 plugin-activate chip 存活
  const whitelisted = toCompress.filter((m) => m.kind && NEVER_COMPRESS_KINDS.has(m.kind));
  const compressedIds = toCompress
    .filter((m) => !(m.kind && NEVER_COMPRESS_KINDS.has(m.kind)))
    .map((m) => m.id);
  const payload: ContextCompressedPayload = {
    compressedMessageIds: compressedIds,
    summaryText: '',
    fallback: true,
  };
  const notificationMessage = makeContextCompressedMessage({
    conversationId,
    payload,
    text: `摘要生成失败，已自动丢弃早期 ${userRounds} 轮内容`,
  });
  return {
    trimmedHistory: [notificationMessage, ...whitelisted, ...keepMessages],
    notificationMessage,
    fallback: true,
  };
}

function makeContextCompressedMessage(args: {
  conversationId: string;
  payload: ContextCompressedPayload;
  text: string;
}): ChatMessage {
  return {
    id: newMessageId(),
    conversationId: args.conversationId,
    role: 'system',
    text: args.text,
    toolCalls: [],
    createdAt: Date.now(),
    done: true,
    kind: 'context-compressed',
    contextCompressed: args.payload,
  };
}

export { PostCompressOverflowError };
