/**
 * 共享 round-trip 内核（D1）——把 anthropic.ts / openaiCompatible.ts 两份 ~90% 重复的
 * `while(true)` 工具 round-trip 编排只写一份。
 *
 * 内核拥有：循环 + abort 检查 + 工具并发执行 + 声明面闸 + tool_result yield + steering/notice
 * 边界 drain + result yield。协议差异（wire 解析、wire 落位、usage 口径、per-call 事件形状、
 * tool_use 事件时机）全下沉给 `ProtocolAdapter`，由各 backend 构造。
 *
 * 第一性：当前「加第二个实现 = 复制 800 行循环」违反 Oru 自己的系统性原则。任一 round-trip bug
 * （usage 跨轮累加、孤儿 tool_call、并发回执顺序、steering 边界时机）原先要修两遍、易只修一遍 →
 * 行为漂移。抽内核后只修一处。设计见 docs/tech/2026-06-24-d1-roundtrip-kernel-design.md。
 */
import type { ConversationEvent, ConversationInput, ConversationUsage, ToolResultImage } from '@shared/agent/backend';
import type { ChatMessage } from '@shared/types';
import { isContextOverflowError } from './overflow';

/** 工具执行结果——与各 backend executeToolSafe 的返回同形。 */
export type ToolExecResult = {
  text: string;
  isError: boolean;
  structured?: Record<string, unknown>;
  /**
   * 工具回传给模型"看"的图像（D2：工具图回传）。
   * 可选字段——不填时行为与之前完全一致（向后兼容）。
   * 三条路径都消费：claude-code 转 MCP image block、Anthropic 拼进 tool_result 的图像块
   * （连的都是 Claude 模型，不判 supportsVision）、OpenAI 兼容按 supportsVision 决定透出
   * 还是丢图并追加「当前模型不支持看图」的说明。
   */
  images?: ToolResultImage[];
};

/** streamOnce 发完一轮后回传给内核的控制信息。 */
export type RoundResult = {
  /** 本轮模型要调的工具（已解析 input、按声明顺序）；空 = 无工具调用。 */
  toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  /** stopReason / finishReason 是否「工具调用」——决定 round-trip 是否继续。 */
  isToolCall: boolean;
  /** 无工具调用时的最终文本（→ result.resultText）。 */
  finalText: string;
  /** 本轮流过 reasoning delta（→ result.sawReasoning，内核跨轮 OR 累积）；不填=无/不支持。 */
  sawReasoning?: boolean;
};

/**
 * 内核与具体 provider 的唯一耦合面。adapter 内部持有 wire history（messages）与跨轮 usage 累加器。
 */
export interface ProtocolAdapter {
  /**
   * 发一轮请求，产出归一事件流（assistant_text / tool_use / retrying / 本 adapter 自造的 llm_usage）——
   * **tool_use 事件由 adapter 在各自时机 yield**（Anthropic 流内即时 / OpenAI 流后批量），内核不重发。
   * 内部完成本轮 usage 累加、并把本轮 assistant 追加回 wire history。
   * generator 的 return 值带控制信息（要不要继续 + 要执行哪些工具 + 无工具时的 finalText）。
   */
  streamOnce(signal: AbortSignal): AsyncGenerator<ConversationEvent, RoundResult>;
  /**
   * tool_results + 边界 drain 出来的 steering/notice 文本追加回 wire history（各自协议形态）。
   * Anthropic 搭同一 user turn；OpenAI 拆 role:'tool' + 独立 user。错误前缀差异收这里。
   * results 顺序 = tool_use 声明顺序。
   */
  appendToolResults(
    results: Array<{ id: string; name: string } & ToolExecResult>,
    steeringTexts: string[],
    noticeTexts: string[],
  ): void;
  /** 跨轮累加的 usage → 最终 result.usage（extended 形状各自不同）。 */
  buildResultUsage(): ConversationUsage | undefined;
  /**
   * 用整理后的 history 重建 seed 段 wire messages（S16 G66 续发检查点）——重跑 adaptHistory＋协议
   * 翻译，本回合内 append 进来的轮次（assistant / tool_result / steering）逐字节保留在其后。
   * seed 段边界由各 adapter 自己持有：openaiCompatible 的 messages[0] 是 system（不属 seed，保留原位）；
   * anthropic 的 seed 经 coalesceAdjacentSameRole 合并，拼接边界须重跑 coalesce 判定防相邻同角色 400。
   */
  replaceSeedHistory(history: ChatMessage[]): Promise<void>;
}

/** 本回合未声明的工具（被白名单/denylist 滤掉或纯属幻觉）的拒绝回执——两 backend 字节级一致。 */
function undeclaredToolResult(name: string): ToolExecResult {
  return { text: `工具 ${name} 不在本回合可用工具集内，未执行`, isError: true, structured: undefined };
}

/**
 * round-trip 编排内核——写一份。两个 HTTP backend 退化成「构造 adapter + yield* runRoundTrip」。
 *
 * @param executeTool 已绑定 ToolContext 的工具执行器（= backend 的 executeToolSafe）。
 * @param declaredToolNames 本回合声明面工具集；不在其中的 tool_use 直接回拒绝回执、不执行。
 */
export async function* runRoundTrip(
  adapter: ProtocolAdapter,
  input: ConversationInput,
  executeTool: (name: string, toolInput: Record<string, unknown>) => Promise<ToolExecResult>,
  declaredToolNames: Set<string>,
): AsyncGenerator<ConversationEvent> {
  let continuationIndex = 0; // 已发生的续发次数；首个请求为 0，之后每次续发 +1（钩子从 1 起）
  let sawReasoning = false; // 跨轮 OR 累积（与 usage 同模式：内核管跨轮，adapter 管单轮）
  while (true) {
    if (input.abortController.signal.aborted) break;

    // 发一轮：透传 adapter 的事件流，结束后拿回控制信息（generator return 值）。
    // 中途被动兜底（S16 G66）：续发轮 streamOnce 在流开始前抛 overflow（400 级请求拒绝）且本轮
    // 尚未 yield 任何事件时，调 onBeforeContinuation({reason:'overflow'}) 强制整理、替换 seed 重发一次；
    // 每回合至多一次。已流出内容的失败不是 overflow、不走此路（那是 S25 续写的地盘）。
    let round: RoundResult | undefined;
    let overflowRetried = false;
    while (round === undefined) {
      const gen = adapter.streamOnce(input.abortController.signal);
      let yieldedThisAttempt = false;
      try {
        let step = await gen.next();
        while (!step.done) {
          yieldedThisAttempt = true;
          yield step.value;
          step = await gen.next();
        }
        round = step.value;
        if (round.sawReasoning) sawReasoning = true;
      } catch (e) {
        if (
          continuationIndex > 0 && // 续发轮才走（首个请求 overflow 归 runner 外层兜底）
          !yieldedThisAttempt && // 流开始前（已流出内容的失败归 S25）
          !overflowRetried && // 每回合至多一次
          isContextOverflowError(e) &&
          input.onBeforeContinuation
        ) {
          overflowRetried = true;
          const organized = await input.onBeforeContinuation({ continuationIndex, reason: 'overflow' });
          if (organized) {
            await adapter.replaceSeedHistory(organized);
            continue; // 重发同一轮
          }
        }
        throw e; // 非 overflow / 非续发 / 已重发过 / 整理无果 → 原错误照抛
      }
    }

    if (!round.isToolCall) {
      yield {
        type: 'result',
        resultText: round.finalText,
        isError: false,
        usage: adapter.buildResultUsage(),
        ...(sawReasoning ? { sawReasoning } : {}),
      };
      return;
    }

    // 并发执行（等齐再继续——两协议都要求每个 tool_use 配回执）；声明面外的拒绝执行回 isError。
    const results = await Promise.all(
      round.toolCalls.map(async (tc) => {
        const r = declaredToolNames.has(tc.name)
          ? await executeTool(tc.name, tc.input)
          : undeclaredToolResult(tc.name);
        return { id: tc.id, name: tc.name, ...r };
      }),
    );

    // tool_result 事件按声明顺序 yield（runner 落盘 + 推 UI）。
    for (const r of results) {
      yield { type: 'tool_result', toolUseId: r.id, isError: r.isError, content: r.text, structured: r.structured };
    }

    // 边界 drain steering + notice，交 adapter 按各自 wire 形态搭进下一轮（两 backend drain 时机相同，
    // 差异只在 wire 落位）。然后进入下一轮 while。
    const steeringTexts = input.drainSteering ? await input.drainSteering() : [];
    const noticeTexts = input.drainBoundaryNotice ? await input.drainBoundaryNotice() : [];
    adapter.appendToolResults(results, steeringTexts, noticeTexts);

    // 续发检查点（S16 G66）：本轮工具回执已就位、下一次模型请求发出之前。调用方（runner）在此
    // 估算是否超水位、超则整理并返回整理后的 seed history；backend 就地替换 seed 段 wire messages，
    // 本回合内 append 进来的轮次逐字节保留其后。返回 null → 照发。首个请求不经此钩子。
    continuationIndex += 1;
    if (input.onBeforeContinuation) {
      const organized = await input.onBeforeContinuation({ continuationIndex, reason: 'checkpoint' });
      if (organized) await adapter.replaceSeedHistory(organized);
    }
  }
}
