/**
 * 事件流 FSM —— 从 ConversationEvent 推导 LLM 调用边界 + 并发组
 *
 * 详见 docs/tech/2026-05-10-debug-module-tech-design.md §5。
 *
 * ─── 协议假设 ────────────────────────────────────────────────────────
 * 本 FSM 假设三个 backend 给出的 ConversationEvent 流满足以下协议：
 *   1. 同一次 LLM 输出内的 tool_use 事件**连续到来**，中间不穿插 assistant_text；
 *   2. tool_use 事件在工具实际执行之前 emit（这样 tool_call_start 时间戳才有意义）；
 *   3. tool_result 事件在工具实际执行之后 emit。
 *
 * 当前 anthropic.ts / claudeCode.ts 满足全部 3 条；openaiCompatible.ts 由 §6.4 顺手修齐。
 *
 * ⚠ Anthropic extended thinking 模式下理论上可能出现 "text → tool_use → text" 的合法
 * content block 排列。本 FSM 把工具阶段的额外文字直接累积到上一次 llm_call_done 的
 * outputText，不视作错误——展现为最后一行 LLM 的 outputText 比预期略长，但不会产生
 * 误报警告。如果将来这种排列影响调试体验，再补显式分支。
 */

import type { BackendType } from '@shared/types';
import type {
  DebugEventType,
  DebugPayloadMap,
  DebugRecord,
  RoundSource,
  DebugAttachment,
} from '@shared/debug/types';
import type { ConversationEvent } from '@shared/agent/backend';

export interface DeriverMeta extends RecordHead {
  backendType: BackendType;
  modelId?: string;
  providerId?: string;
}

type State = 'IDLE' | 'IN_LLM' | 'IN_TOOLS';

interface PendingTool {
  startTs: number;
}

/**
 * 一个 deriver 实例对应一次 backend.runConversation 调用——retry 重试时由 runner
 * 重新构造一个新实例，状态自然 reset。
 */
export class StreamDeriver {
  private readonly meta: DeriverMeta;
  private readonly emit: (rec: DebugRecord) => void;
  private readonly roundStartTs: number;

  private state: State = 'IDLE';
  /** 跨 retry 续接：第一次 retry 时由 RoundLogger 传入上次结束的 callIndex */
  private callIndex: number;
  private seq: number;

  // 当前 LLM 调用累积
  private currentLlmStartTs = 0;
  private currentLlmFirstTokenTs?: number;
  private currentLlmOutputText = '';
  /** 当前 LLM 调用尚未 emit llm_call_done。等 llm_usage 到来时才 emit；
   *  result/tool_use 等其他终结路径上做兜底（如 claudeCode 不发 llm_usage） */
  private currentLlmPendingEnd = false;
  /** 第一次 tool_use 到来时记的"LLM 输出实际结束"时间——
   *  比 stream 末 llm_usage 早几 ms 但更准确反映"LLM 不再吐字"的时刻 */
  private firstToolUseTs?: number;

  // 当前并发组累积
  private currentGroupId?: string;
  private currentGroupStartTs = 0;
  private pendingTools = new Map<string, PendingTool>();
  private completedToolCount = 0;
  private totalToolCount = 0;
  private longestToolDurationMs = 0;

  // 最终汇总
  private totalLlmCallCount = 0;
  private totalToolCallCount = 0;
  private totalInputTokens = 0;
  private totalOutputTokens = 0;
  private finalActualModel?: string;

  constructor(
    meta: DeriverMeta,
    emit: (rec: DebugRecord) => void,
    roundStartTs: number,
    startSeq: number,
    startCallIndex: number = 0,
  ) {
    this.meta = meta;
    this.emit = emit;
    this.roundStartTs = roundStartTs;
    this.seq = startSeq;
    this.callIndex = startCallIndex;
    this.beginLlmCall();
  }

  /** 当前已结束的 LLM 调用累计——RoundLogger 在 retry 时取这个传给下一个 deriver 实例 */
  getCallIndex(): number {
    return this.callIndex;
  }

  /** 当前内部 seq——RoundLogger 在 retry 时取它续接，保证跨 deriver 的 seq 不重叠 */
  getSeq(): number {
    return this.seq;
  }

  feed(ev: ConversationEvent): void {
    switch (ev.type) {
      case 'session':
        // session id 跟 debug 模块无关，跳过
        return;
      case 'assistant_text':
        if (this.state === 'IN_LLM') {
          if (this.currentLlmFirstTokenTs === undefined) {
            this.currentLlmFirstTokenTs = Date.now();
          }
        }
        // IN_TOOLS 时直接累积到上一次 LLM 的 outputText（extended thinking 兼容）
        this.currentLlmOutputText += ev.text;
        return;
      case 'tool_use': {
        const startTs = Date.now();
        if (this.state === 'IN_LLM') {
          // LLM stream 还没在 backend 端完全结束（llm_usage 尚未到），但 tool_use 已经流出来——
          // 记下"LLM 输出结束"的精确时刻给 endLlmCall 用，但 emit llm_call_done 推迟到 llm_usage 到达，
          // 这样 token 数才能填进 payload。
          this.firstToolUseTs = startTs;
          this.beginParallelGroup();
        }
        // 进入或停留在 IN_TOOLS
        this.state = 'IN_TOOLS';
        this.pendingTools.set(ev.id, { startTs });
        this.totalToolCount += 1;
        this.totalToolCallCount += 1;
        this.emitRecord('tool_call_start', {
          toolCallId: ev.id,
          name: ev.name,
          input: ev.input,
          parallelGroupId: this.currentGroupId,
        });
        return;
      }
      case 'llm_usage': {
        // 本次 LLM stream 在 backend 端结束 —— 把 tokens 填进 llm_call_done。
        // 主因：tokens 只在 stream 末才到（OpenAI 兼容路径靠 stream_options.include_usage 末尾 chunk；
        //       Anthropic 在 message_delta 末），所以 endLlmCall 必须由 llm_usage 触发才能拿到 token 数。
        // 副作用：llm_usage 到达时可能已经进入工具执行阶段；用 firstToolUseTs 作为 endTs 让 durationMs
        //       不被工具执行时间污染（"LLM 不再吐字"的真实时刻）。没工具就用 now。
        // 拿不到的 backend（claudeCode）不发此事件：中间调用由 tool_result 关组兜底、
        // 末次调用由 result 兜底，终结不依赖 llm_usage。
        if (this.currentLlmPendingEnd) {
          const endTs = this.firstToolUseTs ?? Date.now();
          const reasoningTokens = ev.extended?.reasoningTokens;
          this.endLlmCall(
            endTs,
            ev.inputTokens,
            ev.outputTokens,
            ev.cacheReadTokens,
            typeof reasoningTokens === 'number' ? reasoningTokens : undefined,
            ev.finishReason,
          );
        }
        return;
      }
      case 'tool_result': {
        const pending = this.pendingTools.get(ev.toolUseId);
        const endTs = Date.now();
        const durationMs = pending ? endTs - pending.startTs : 0;
        this.longestToolDurationMs = Math.max(this.longestToolDurationMs, durationMs);
        this.pendingTools.delete(ev.toolUseId);
        this.completedToolCount += 1;
        this.emitRecord('tool_call_done', {
          toolCallId: ev.toolUseId,
          durationMs,
          isError: ev.isError,
          output: ev.content,
          structured: ev.structured,
          parallelGroupId: this.currentGroupId,
        });
        // group 内全部 done → 关组 + 重新进 LLM
        if (this.completedToolCount === this.totalToolCount && this.currentGroupId) {
          this.endParallelGroup();
          // 兜底终结上一次 LLM 调用。"进入工具阶段"本身就是"LLM 不再吐字"的结构性边界，
          // 不该依赖可选的 llm_usage——claudeCode 后端不发 llm_usage，缺了它中间每次带工具的
          // 调用都会 pending 到死，被前端误标「未完成」。发 llm_usage 的 backend
          // （anthropic/openai）此时 pendingEnd 已是 false，自动跳过、不会重复 done。
          if (this.currentLlmPendingEnd) {
            this.endLlmCall(this.firstToolUseTs ?? Date.now());
          }
          this.state = 'IN_LLM';
          this.beginLlmCall();
        }
        return;
      }
      case 'retrying':
        // 不再 emit retrying record（用户看 round_done.hadError 就够）
        return;
      case 'result': {
        // 兜底：claudeCode 不发 llm_usage，到 result 时当前 LLM 还没 emit done
        if (this.currentLlmPendingEnd) {
          this.endLlmCall(Date.now());
        }
        // 抓 usage（中性容器）
        const usage = ev.usage;
        if (usage) {
          this.totalInputTokens += usage.inputTokens ?? 0;
          this.totalOutputTokens += usage.outputTokens ?? 0;
          if (usage.actualModel) this.finalActualModel = usage.actualModel;
        }
        const finalText = ev.resultText ?? '';
        const totalDurationMs = Date.now() - this.roundStartTs;
        this.emitRecord('final_answer', {
          text: finalText,
          aborted: false,
          totalDurationMs,
          totalInputTokens: this.totalInputTokens,
          totalOutputTokens: this.totalOutputTokens,
          finalModel: this.finalActualModel,
        });
        return;
      }
    }
  }

  /** 一轮收束（runner 在所有 backend 调用结束后调一次） */
  finishRound(hadError: boolean): void {
    // abort / 超时等没走到 'result' 的收尾：当前 LLM 调用仍 pending（只 emit 过 llm_call_start）。
    // 补一条 llm_call_done 收口，否则面板上"有 start 无 done"会被误判成卡死。token 拿不到留空。
    if (this.currentLlmPendingEnd) {
      this.endLlmCall(this.firstToolUseTs ?? Date.now());
    }
    this.emitRecord('round_done', {
      totalDurationMs: Date.now() - this.roundStartTs,
      llmCallCount: this.totalLlmCallCount,
      toolCallCount: this.totalToolCallCount,
      hadError,
      // 冗余 token 汇总：listSessions 读首末行就能展示 token，不用多读 final_answer
      totalInputTokens: this.totalInputTokens || undefined,
      totalOutputTokens: this.totalOutputTokens || undefined,
      finalModel: this.finalActualModel,
    });
  }

  /** 一轮中途出错 */
  emitError(payload: DebugPayloadMap['error']): void {
    this.emitRecord('error', payload);
  }

  // ─── 内部辅助 ────────────────────────────────────────

  private beginLlmCall(): void {
    this.callIndex += 1;
    this.totalLlmCallCount += 1;
    this.currentLlmStartTs = Date.now();
    this.currentLlmFirstTokenTs = undefined;
    this.currentLlmOutputText = '';
    this.currentLlmPendingEnd = true;
    this.firstToolUseTs = undefined;
    this.state = 'IN_LLM';
    this.emitRecord('llm_call_start', {
      callIndex: this.callIndex,
      model: this.meta.modelId,
      providerId: this.meta.providerId,
      backendType: this.meta.backendType,
    });
  }

  /** 结束当前 LLM 调用并 emit llm_call_done。
   *  endTs：LLM 真正"不再吐字"的时刻；正常路径 = first tool_use ts，没工具 = stream 末。
   *  inputTokens / outputTokens / cacheReadTokens / reasoningTokens：来自 backend llm_usage；undefined 表示未拿到。
   *  finishReason：透传 backend 给的 finish_reason，'length' 表示输出被截断。 */
  private endLlmCall(
    endTs: number,
    inputTokens?: number,
    outputTokens?: number,
    cacheReadTokens?: number,
    reasoningTokens?: number,
    finishReason?: string,
  ): void {
    const firstTokenMs = this.currentLlmFirstTokenTs
      ? this.currentLlmFirstTokenTs - this.currentLlmStartTs
      : undefined;
    this.emitRecord('llm_call_done', {
      callIndex: this.callIndex,
      durationMs: endTs - this.currentLlmStartTs,
      firstTokenMs,
      outputText: this.currentLlmOutputText,
      // 0 视作"不可信值"（不支持 include_usage 的 OpenAI 兼容 provider 累加成 0）→ 不写
      inputTokens: inputTokens && inputTokens > 0 ? inputTokens : undefined,
      outputTokens: outputTokens && outputTokens > 0 ? outputTokens : undefined,
      // cacheReadTokens / reasoningTokens 同语义：undefined 透传（"未返回 usage"），0 也透传（"真未命中"）
      cacheReadTokens,
      reasoningTokens,
      finishReason,
    });
    this.currentLlmPendingEnd = false;
    this.firstToolUseTs = undefined;
  }

  private beginParallelGroup(): void {
    this.currentGroupId = `${this.meta.roundId}-g-${this.callIndex}`;
    this.currentGroupStartTs = Date.now();
    this.completedToolCount = 0;
    this.totalToolCount = 0;
    this.longestToolDurationMs = 0;
    this.emitRecord('parallel_group_start', {
      groupId: this.currentGroupId,
      llmCallIndex: this.callIndex,
    });
  }

  private endParallelGroup(): void {
    if (!this.currentGroupId) return;
    this.emitRecord('parallel_group_done', {
      groupId: this.currentGroupId,
      llmCallIndex: this.callIndex,
      longestDurationMs: this.longestToolDurationMs,
    });
    this.currentGroupId = undefined;
  }

  private emitRecord<K extends DebugEventType>(type: K, payload: DebugPayloadMap[K]): void {
    const ts = Date.now();
    this.emit({
      ts,
      relMs: ts - this.roundStartTs,
      roundId: this.meta.roundId,
      conversationId: this.meta.conversationId,
      ownerId: this.meta.ownerId,
      agentId: this.meta.agentId,
      agentName: this.meta.agentName,
      type,
      seq: ++this.seq,
      payload,
    } as DebugRecord<K>);
  }
}

/** record 头部字段——logger 和 deriver 都用，不含 backendType（那是 deriver 自己的事） */
export interface RecordHead {
  roundId: string;
  conversationId: string;
  ownerId: string;
  agentId: string;
  agentName: string;
}

/** 让 logger 构造 round_start 时方便传：固定 schema 的 helper（不属于 FSM 状态） */
export function makeRoundStartRecord(
  head: RecordHead,
  source: RoundSource,
  userText: string,
  attachments?: DebugAttachment[],
  triggerCtx?: Record<string, unknown>,
): DebugRecord<'round_start'> {
  const ts = Date.now();
  return {
    ts,
    relMs: 0,
    ...head,
    type: 'round_start',
    seq: 0,
    payload: { source, userText, attachments, triggerCtx },
  };
}
