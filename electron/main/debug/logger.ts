/**
 * DebugLogger 单例 + RoundLogger
 *
 * 详见 docs/tech/2026-05-10-debug-module-tech-design.md §4.3。
 *
 * 关闭态保证：
 * - beginRound 第一行就检查 enabled；返回的 NoOp 实例所有方法是 () => {}。
 * - 调用方无须 if 包裹——参数构造的微小成本远低于 LLM/IO，主路径几乎零开销。
 * - setEnabled(false) 后 writer 加 closed 标志立即拒绝新 enqueue（writer.ts）。
 */

import type { BackendType } from '@shared/types';
import type { ConversationUsage } from '@shared/agent/backend';
import type { DebugAttachment, DebugPayloadMap, DebugRecord, RoundSource } from '@shared/debug/types';
import { debugDir } from '../runtime/paths';
import { DebugWriter } from './writer';
import { dateKey, sweepExpiredDebugDays } from './retention';
import { StreamDeriver, makeRoundStartRecord, type DeriverMeta, type RecordHead } from './derive';

export interface RoundMeta {
  roundId: string;
  conversationId: string;
  ownerId: string;
  /** agentId / agentName 后台 oneShot 调用（压缩/命名/网页摘要）拿不到时可省，落盘回落空串 */
  agentId?: string;
  agentName?: string;
  source: RoundSource;
  userText: string;
  attachments?: DebugAttachment[];
  triggerCtx?: Record<string, unknown>;
}

/** backend 实例上 debug 需要的三个只读字段——A 类给 deriver 做 meta，B 类进 llm_call_start */
export interface BackendDebugInfo {
  backendType: BackendType;
  modelId?: string;
  providerId?: string;
}

/** recordOneShot 的结果参数——一次 runOneShot 的产出 */
export interface OneShotRecord {
  text: string;
  usage?: ConversationUsage;
}

/**
 * RoundLogger 接口 —— 真实实现 + NoOp 实现都符合此 shape。
 * 调用方拿到引用就调，不需要判断是不是 NoOp。
 *
 * 注：没有 finalAnswer 方法——A 类事件流的 final_answer 由 deriver 在消费
 * ConversationEvent 'result' 时自动 emit（详 derive.ts），runner 不需要也不应该手动调；
 * B 类 oneShot 的 final_answer 由 recordOneShot 一并落。
 */
export interface RoundLogger {
  promptBuilt(payload: DebugPayloadMap['prompt_built']): void;
  /** 推理视图裁剪节省统计——backend 通过 onInferenceView 回调透传，每次 runConversation 一条 */
  inferenceView(payload: DebugPayloadMap['inference_view']): void;
  /** 每次 backend.runConversation 出新 handle 时调一次，得到一个新 deriver 实例 */
  makeStreamDeriver(args: BackendDebugInfo): StreamDeriver | null;
  /**
   * 一次 runOneShot 发出前调用：立即落 llm_call_start。
   * 在 run() 前落而非成功后补写——start 落盘但 done 未落盘 = LLM 卡死，这是该记录的本职
   * （详 shared/debug/types.ts 文件头）；调用抛错时 done() 会补 llm_call_done 收口。
   */
  oneShotStart(backend: BackendDebugInfo): void;
  /** 一次 runOneShot 成功后调用：落 llm_call_done（带 usage）+ final_answer */
  recordOneShot(result: OneShotRecord): void;
  done(opts: { hadError: boolean }): void;
  error(payload: DebugPayloadMap['error']): void;
}

const NOOP_ROUND_LOGGER: RoundLogger = {
  promptBuilt() {},
  inferenceView() {},
  makeStreamDeriver() {
    return null;
  },
  oneShotStart() {},
  recordOneShot() {},
  done() {},
  error() {},
};

class RealRoundLogger implements RoundLogger {
  private readonly writer: DebugWriter;
  private readonly meta: RoundMeta;
  private readonly roundStartTs: number;
  private seq = 0;
  /** 当前 deriver（每次 retry 重新构造） */
  private currentDeriver: StreamDeriver | null = null;
  /** 累积的 LLM 调用数——deriver 路径作 startCallIndex 续接，oneShot 路径由 oneShotStart 递增 */
  private llmCallsSoFar = 0;
  /** 进行中的 oneShot 调用——recordOneShot 正常关闭；run() 抛错时由 done() 补 llm_call_done 收口 */
  private pendingOneShot: { callIndex: number; startTs: number } | null = null;
  /** oneShot 路径的 usage——done() 落 round_done 时冗余进汇总（与 deriver.finishRound 对齐） */
  private oneShotUsage?: ConversationUsage;

  constructor(writer: DebugWriter, meta: RoundMeta) {
    this.writer = writer;
    this.meta = meta;
    this.roundStartTs = Date.now();
    // 落盘 round_start
    const rec = makeRoundStartRecord(
      this.recordHead(),
      meta.source,
      meta.userText,
      meta.attachments,
      meta.triggerCtx,
    );
    this.writer.enqueue(rec);
  }

  promptBuilt(payload: DebugPayloadMap['prompt_built']): void {
    this.emit('prompt_built', payload);
  }

  inferenceView(payload: DebugPayloadMap['inference_view']): void {
    this.emit('inference_view', payload);
  }

  makeStreamDeriver(args: BackendDebugInfo): StreamDeriver {
    // 当前 deriver 在被替换前先把它累积的 LLM 调用数存下来——保证跨 retry 续接
    if (this.currentDeriver) {
      this.llmCallsSoFar = this.currentDeriver.getCallIndex();
      // seq 同步续接：this.seq 只随 logger 自身 emit 递增，不取回 deriver 内部 seq 的话
      // retry 后新 deriver 的事件段会大量重叠；取 max 防 logger 自身 emit 跑得更快的边界
      this.seq = Math.max(this.seq, this.currentDeriver.getSeq());
    }
    const meta: DeriverMeta = {
      ...this.recordHead(),
      backendType: args.backendType,
      modelId: args.modelId,
      providerId: args.providerId,
    };
    this.currentDeriver = new StreamDeriver(
      meta,
      (rec) => this.writer.enqueue(rec),
      this.roundStartTs,
      this.seq, // 续接 seq 计数
      this.llmCallsSoFar, // 续接 callIndex 计数
    );
    return this.currentDeriver;
  }

  oneShotStart(backend: BackendDebugInfo): void {
    const callIndex = ++this.llmCallsSoFar;
    this.pendingOneShot = { callIndex, startTs: Date.now() };
    this.emit('llm_call_start', {
      callIndex,
      model: backend.modelId,
      providerId: backend.providerId,
      backendType: backend.backendType,
    });
  }

  recordOneShot(result: OneShotRecord): void {
    const pending = this.pendingOneShot;
    if (!pending) return; // 没 start 过——debug 记录缺失不该影响主流程
    this.pendingOneShot = null;
    this.oneShotUsage = result.usage;
    // cache/reasoning 两维在 ConversationUsage.extended（key 约定见 NORMALIZED_USAGE_KEYS）
    const ext = result.usage?.extended;
    const cacheReadTokens = ext?.cacheReadTokens;
    const reasoningTokens = ext?.reasoningTokens;
    const endTs = Date.now();
    this.emit('llm_call_done', {
      callIndex: pending.callIndex,
      durationMs: endTs - pending.startTs,
      // firstTokenMs 不写：oneShot 一次性返回，没有"首 token"概念
      outputText: result.text,
      // 0 视作不可信值不写；cache/reasoning 三态透传——语义同 derive.ts endLlmCall
      inputTokens: result.usage?.inputTokens || undefined,
      outputTokens: result.usage?.outputTokens || undefined,
      cacheReadTokens: typeof cacheReadTokens === 'number' ? cacheReadTokens : undefined,
      reasoningTokens: typeof reasoningTokens === 'number' ? reasoningTokens : undefined,
    });
    this.emit('final_answer', {
      text: result.text,
      aborted: false,
      totalDurationMs: endTs - this.roundStartTs,
      totalInputTokens: result.usage?.inputTokens ?? 0,
      totalOutputTokens: result.usage?.outputTokens ?? 0,
      finalModel: result.usage?.actualModel,
    });
  }

  done(opts: { hadError: boolean }): void {
    if (this.currentDeriver) {
      this.currentDeriver.finishRound(opts.hadError);
      return;
    }
    // oneShot 抛错路径：调用已 start 未 done——补 llm_call_done 收口（同 finishRound
    // 的 pendingEnd 兜底），否则面板上"有 start 无 done"会被误判成卡死。token 拿不到留空。
    if (this.pendingOneShot) {
      this.emit('llm_call_done', {
        callIndex: this.pendingOneShot.callIndex,
        durationMs: Date.now() - this.pendingOneShot.startTs,
        outputText: '',
      });
      this.pendingOneShot = null;
    }
    // 没起过 deriver（oneShot 路径 / 极早期失败）：自己 emit round_done，llmCallCount 取累积值
    this.emit('round_done', {
      totalDurationMs: Date.now() - this.roundStartTs,
      llmCallCount: this.llmCallsSoFar,
      toolCallCount: 0,
      hadError: opts.hadError,
      totalInputTokens: this.oneShotUsage?.inputTokens || undefined,
      totalOutputTokens: this.oneShotUsage?.outputTokens || undefined,
      finalModel: this.oneShotUsage?.actualModel,
    });
  }

  error(payload: DebugPayloadMap['error']): void {
    if (this.currentDeriver) {
      this.currentDeriver.emitError(payload);
    } else {
      this.emit('error', payload);
    }
  }

  /** 公共头部字段——deriver 用它做 record meta，RoundLogger 自己 emit 时也用 */
  private recordHead(): RecordHead {
    return {
      roundId: this.meta.roundId,
      conversationId: this.meta.conversationId,
      ownerId: this.meta.ownerId,
      agentId: this.meta.agentId ?? '',
      agentName: this.meta.agentName ?? '',
    };
  }

  private emit<K extends keyof DebugPayloadMap>(type: K, payload: DebugPayloadMap[K]): void {
    const ts = Date.now();
    this.writer.enqueue({
      ts,
      relMs: ts - this.roundStartTs,
      ...this.recordHead(),
      type,
      seq: ++this.seq,
      payload,
    } as DebugRecord);
  }
}

export class DebugLogger {
  private enabled = false;
  private writer: DebugWriter | null = null;
  /** 上次跑留存清理的日期——换日后的第一轮触发一次，避免每轮 readdir */
  private lastSweptDay = '';

  setEnabled(on: boolean): void {
    if (this.enabled === on) return;
    this.enabled = on;
    if (!on && this.writer) {
      // 异步关闭，吞错——不阻塞调用方
      void this.writer.flushAndClose().catch(() => {});
      this.writer = null;
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  beginRound(meta: RoundMeta): RoundLogger {
    // 留存清理放在 enabled 检查之前——调试日志关着时，盘上旧日志照样要过期
    const today = dateKey(Date.now());
    if (today !== this.lastSweptDay) {
      this.lastSweptDay = today;
      void sweepExpiredDebugDays(debugDir(meta.ownerId)).catch(() => {});
    }
    if (!this.enabled) return NOOP_ROUND_LOGGER;
    if (!this.writer) this.writer = new DebugWriter();
    return new RealRoundLogger(this.writer, meta);
  }

  /** 测试钩子：等所有积压 record 落盘 */
  async flushForTest(): Promise<void> {
    if (this.writer) {
      await this.writer.flushAndClose();
      this.writer = null;
    }
  }
}

export const debugLogger = new DebugLogger();
