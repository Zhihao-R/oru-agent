/**
 * 调试模块 schema —— 落盘 NDJSON 的事件 record 类型
 *
 * 详见 docs/tech/2026-05-10-debug-module-tech-design.md §3。
 *
 * 11 种事件类型：
 * - round_start    一轮开始 + 用户输入（含 text / attachments）
 * - prompt_built   整段 systemContext + history 落盘
 * - llm_call_start LLM 调用开始（用于诊断"卡住"——start 落盘但 done 未落盘 = LLM 卡死）
 * - llm_call_done  LLM 调用结束（含 firstTokenMs / token / actualModel / extended）
 * - parallel_group_start  并发组开始（来自同一 LLM 输出的多个 tool_use）
 * - parallel_group_done   并发组结束
 * - tool_call_start 工具开始（用于诊断"卡住"）
 * - tool_call_done  工具结束
 * - final_answer    时间线末点
 * - round_done      一轮收束（含汇总）
 * - error           任何阶段抛错
 */

import type { InferenceViewSavings } from '@shared/agent/backend';
import type { NormalizedMessage } from '@shared/agent/normalizedMessage';
import type { BackendType } from '@shared/types';

export type DebugEventType =
  | 'round_start'
  | 'prompt_built'
  | 'inference_view'
  | 'llm_call_start'
  | 'llm_call_done'
  | 'parallel_group_start'
  | 'parallel_group_done'
  | 'tool_call_start'
  | 'tool_call_done'
  | 'final_answer'
  | 'round_done'
  | 'error';

/**
 * 一次"行为"的触发来源。前端按它打类型 chip（标签在各语言包 debug.json 的 source 组）。
 *
 * - main_chat / comment：用户在主对话 / 任务板评论里发起
 * - taskboard：任务板的编码 subagent（propose/approve/exec 生命周期）
 * - subagent：对话期 Task 工具派出的 subagent
 * - background：背景 Twin（子 agent 反问 / 空闲播报判断）
 * - dream / capture：后台记忆复盘 / 增量抓取
 * - compress / auto_name / web_summary：主对话附属的轻量 oneShot 调用
 * - aside_comment：随手评点的 one-shot 短评（试探期无对话，归到固定伪会话分组）
 *
 * 注：后端 listSessions 对该字段直接透传（cast），新增值无需改切分逻辑；
 * 前端缺译文时回落 '未知'，加值由 ROUND_SOURCES 全集（编译期）+ debugZh 测试（运行期）逼你补译文。
 */
export type RoundSource =
  | 'main_chat'
  | 'comment'
  | 'taskboard'
  | 'subagent'
  | 'background'
  | 'dream'
  | 'capture'
  | 'compress'
  | 'auto_name'
  | 'web_summary'
  | 'aside_comment'
  | 'loop_reviewer'
  | 'loop_compile'
  | 'loop_work'
  | 'memory_recall'
  | 'self_knowledge'
  | 'platform'
  | 'scheduled';

/**
 * RoundSource 运行时全集——key 取自 `satisfies Record<RoundSource, 0>`，漏列任一成员即 TS 报错。
 * 恢复抽 i18n 后丢失的「枚举↔译文同步」编译期护栏；debugZh 测试遍历它校验每个 source 都有非回落译文。
 */
export const ROUND_SOURCES = Object.keys({
  main_chat: 0,
  comment: 0,
  taskboard: 0,
  subagent: 0,
  background: 0,
  dream: 0,
  capture: 0,
  compress: 0,
  auto_name: 0,
  web_summary: 0,
  aside_comment: 0,
  loop_reviewer: 0,
  loop_compile: 0,
  loop_work: 0,
  memory_recall: 0,
  self_knowledge: 0,
  platform: 0,
  scheduled: 0,
} satisfies Record<RoundSource, 0>) as RoundSource[];

export interface DebugAttachment {
  name: string;
  bytes: number;
  path: string;
}

export interface DebugRecord<T extends DebugEventType = DebugEventType> {
  /** 绝对 UTC 毫秒；多条 record 在同一文件里时间单调递增（同一进程时钟） */
  ts: number;
  /** 相对本轮 round_start 的毫秒；round_start 自己 = 0 */
  relMs: number;
  /** 一轮对话的唯一 id（沿用 router 生成的 messageId） */
  roundId: string;
  /** 会话 id（cross-round） */
  conversationId: string;
  /** 数据归属（当前 MVP 阶段固定为 'local-user'） */
  ownerId: string;
  agentId: string;
  agentName: string;
  type: T;
  /** 同一 roundId 内单调递增，前端排序兜底 */
  seq: number;
  payload: DebugPayloadMap[T];
}

export interface DebugPayloadMap {
  round_start: {
    source: RoundSource;
    triggerCtx?: Record<string, unknown>;
    /** 用户提问的完整文本 */
    userText: string;
    attachments?: DebugAttachment[];
  };
  prompt_built: {
    durationMs: number;
    systemContextChars: number;
    stableSystemContextChars: number;
    /** 整段 systemContext 落盘（开关在 redact 之后） */
    systemContext: string;
    // v0.5：原 history / historyCount 字段已移除——真实入参由 inference_view.wireHistory 承载，
    // raw history 落盘没有诊断价值（adapter 之前的中间对象，跟模型实际看到的不是同一份）。
  };
  /**
   * 推理视图裁剪 telemetry + adapter 输出归档。
   *
   * 每次 backend.runConversation 出一条（撞墙 retry / passive compress 后的二次 runConversation 各自一条）。
   *
   * v0.5：从「轻量统计快照」升级为「统计 + payload 归档」——新增 wireHistory 字段承载
   * adapter 之后的真实入参，单条 payload 体量从几十 bytes 升到 5-30 KB。
   *
   * 历史 ndjson 缺 wireHistory 字段；claudeCode resume 路径 wireHistory 为空数组（adapter 未跑）。
   * 前端通过 getWireHistoryDisplay helper 集中兜底三种情况：present / resume / legacy。
   */
  inference_view: {
    enabled: boolean;
    /**
     * adapter 是否真的跑过——resume 路径（claudeCode SDK 续 session）false，其他场景 true。
     * 老 ndjson 缺该字段。用独立 boolean 而非"wireHistory 为空数组"作 resume 信号——
     * 正常 adapter 在边界输入下也可能返回 []，信号位选合法值会撞车。
     */
    adapterRan?: boolean;
    savings: InferenceViewSavings;
    /** adapter 之后的 wireHistory（PRD 术语：真实入参） */
    wireHistory?: NormalizedMessage[];
  };
  llm_call_start: {
    callIndex: number;
    model?: string;
    providerId?: string;
    backendType: BackendType;
  };
  llm_call_done: {
    callIndex: number;
    durationMs: number;
    /** 首 token 延迟（合并自旧 llm_first_token，不再单独事件） */
    firstTokenMs?: number;
    /** 这次 LLM 输出的纯文本聚合（assistant_text 拼接） */
    outputText: string;
    /**
     * 本次 LLM 调用的输入 token 数。来自 backend 在每次 LLM stream 结束时 yield
     * 的 'llm_usage' 事件——derive 端绑到这条 done 上。
     * 拿不到（如 ClaudeCodeBackend SDK 不暴露、OpenAI 兼容 provider 不支持 include_usage）
     * 时为 undefined。
     */
    inputTokens?: number;
    /** 本次 LLM 调用的输出 token 数；同上来源 */
    outputTokens?: number;
    /**
     * 本次 LLM 调用 prompt cache 命中 token 数。
     * undefined → backend 没拿到 usage（智谱平台偶发漏 / 不支持 include_usage 的 OpenAI 兼容 provider）。
     * 0 → 拿到 usage 但本次未命中。
     * > 0 → 命中。
     * UI 端三态需视觉可区分。
     */
    cacheReadTokens?: number;
    /**
     * 本次 reasoning 阶段消耗的 token 数（推理模型独有）。
     * 三态语义同 cacheReadTokens：undefined = 未拿到 usage / 非推理模型；0 = 本次未思考。
     * reasoningTokens 接近 max_tokens 时 content 必被挤压——排查输出截断的关键指标。
     */
    reasoningTokens?: number;
    /** 同 ConversationEvent.llm_usage.finishReason。'length' 表示输出被截断。 */
    finishReason?: string;
  };
  parallel_group_start: {
    groupId: string;
    llmCallIndex: number;
    /**
     * 注意：FSM 见到第一个 tool_use 时不知道总数，所以这里**没有** expectedCount
     * 字段。前端从 group 内 tool_call_start 数量自己数；parallel_group_done.longestDurationMs
     * 提供组耗时。
     */
  };
  parallel_group_done: {
    groupId: string;
    llmCallIndex: number;
    longestDurationMs: number;
  };
  tool_call_start: {
    toolCallId: string;
    name: string;
    input: Record<string, unknown>;
    parallelGroupId?: string;
  };
  tool_call_done: {
    toolCallId: string;
    durationMs: number;
    isError: boolean;
    output: unknown;
    structured?: Record<string, unknown>;
    parallelGroupId?: string;
  };
  final_answer: {
    text: string;
    aborted: boolean;
    totalDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    finalModel?: string;
  };
  round_done: {
    totalDurationMs: number;
    llmCallCount: number;
    toolCallCount: number;
    hadError: boolean;
    /**
     * 整轮累计 token——冗余自 final_answer，方便 listSessions 只读首末两行就能拿到 token 汇总
     * （否则前端列表展示 token 时还要多读一行 final_answer）。
     */
    totalInputTokens?: number;
    totalOutputTokens?: number;
    finalModel?: string;
  };
  error: {
    code?: string;
    message: string;
    stack?: string;
    phase: 'prompt_build' | 'llm' | 'tool' | 'stream' | 'unknown';
  };
}

/**
 * 推荐的 normalized usage key 命名——三个 backend 在填 extendedUsage 时统一用这些 key，
 * UI 就能横跨 backend 对齐展示（详见 tech design §6.1）。
 */
export const NORMALIZED_USAGE_KEYS = {
  cacheReadTokens: 'cacheReadTokens',
  cacheWriteTokens: 'cacheWriteTokens',
  reasoningTokens: 'reasoningTokens',
} as const;

/**
 * 一次"行为"的汇总—— main 进程扫一遍 ndjson 切分出来，renderer 列表渲染用。
 *
 * 命名：一个文件可能装多个 RoundSummary（同一 conversation 内的多轮 round_start/round_done
 * 切分而成）。dateKey + conversationId 定位文件、roundId 定位轮——这三者构成稳定 key。
 *
 * 字段集合严格按列表展现需求收敛——token / 调用计数 / 模型 / agentId 等
 * 详情才需要的字段不在这里冗余，进抽屉时直接从原 record 取。
 *
 * 设计原则：main/renderer 共享类型——避免双份漂移。
 */
export interface RoundSummary {
  /** 文件归属的日期目录 YYYY-MM-DD */
  dateKey: string;
  /** ndjson 文件名里的 conversationId */
  conversationId: string;
  /** round_start.roundId —— 轮次稳定 id，列表 React key */
  roundId: string;
  source: RoundSource;
  agentName: string;
  /** 用户提问文本——列表预览截断版（200 码点 + …）；完整原文走 debug:read 取 round_start payload */
  userText: string;
  /** round_start.ts（绝对毫秒），列表排序主键 */
  startTs: number;
  /** round_done.totalDurationMs（整轮跑完才有；进行中 / kill -9 时 undefined） */
  durationMs?: number;
  hadError?: boolean;
  /** 出错时的简述（截断后），来自最后一条 error event 的 message */
  errorMessage?: string;
  /** 文件最后修改时间——startTs 缺时兜底排序用 */
  fileMtimeMs: number;
}
