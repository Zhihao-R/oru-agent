/**
 * historyAdapter — 把 ChatMessage[]（带 toolCalls + result）翻译成 backend 可发的中性消息形态。
 *
 * 输出 NormalizedMessage[] 用 Anthropic 风格的 content blocks 表达 tool_use / tool_result——
 * 它能 1:1 表达多 tool 调用 + 各自 result 的关系。OpenAI 风格 backend 在自己内部把
 * tool_result blocks 拆成 role:'tool' 消息即可。
 *
 * 三种形态：
 * - 同协议透传：toolProtocol === targetProtocol → 按原协议块发
 * - 跨协议折叠：toolCalls / toolResults 折叠进一段 assistant text
 * - 悬空 tool_use：result 缺失的 toolCall 只描述"调用了 X 但未完成"
 *
 * 老数据 backendType / toolProtocol 缺省视同 'claude-code' / 'sdk-mcp'。
 *
 * v0.4：源头落盘上线后，"老轮工具结果收敛"机制下线——
 *   - result.persistedRef 存在时发 preview（最近/老轮一视同仁）
 *   - record_memory 成功回执统一压成 detail 第一行（白名单去重，§写入型回执去重）
 *   - 不再有 useShortSummary / fullDetailFromIdx 参数
 */
import type { InferenceViewSavings } from '@shared/agent/backend';
import { normalizeToolName } from '@shared/agent/toolName';
import type {
  AssistantBlock,
  NormalizedMessage,
  UserBlock,
} from '@shared/agent/normalizedMessage';
import type { ChatAttachment, ChatMessage, ToolCall, ToolProtocol } from '@shared/types';

/**
 * Feature flag：推理视图裁剪（裁 2 system 过滤 + 写入型回执去重）。
 * 默认开。设 ORU_INFERENCE_VIEW=0 紧急关闭。
 *
 * 注意：源头落盘（v0.4）**不**受此 flag 控制——它跟 .tool-cache/ 目录绑定，写盘后回不去。
 */
export function isInferenceViewEnabled(): boolean {
  return process.env.ORU_INFERENCE_VIEW !== '0';
}

// role=system 消息只有 'context-compressed'（v0.2 摘要卡）需发给 LLM，其余 kind
// （memory-record / turn-terminator / task-report）都是 UI 通知，不发。等出现下一种"应放行"
// 的 kind 再抽白名单 Set。

/**
 * marker 摘要正文翻成 assistant text 时的 XML 包裹标签——让 LLM 把它识别为 meta 信息
 * 而非用户/助手的直接对话内容。Anthropic 训练 corpus 里 XML tag 是 meta 内容的惯例，
 * 比中文括号 / 引号识别更稳。
 */
const COMPRESSED_SUMMARY_OPEN = '<previous_conversation_summary>';
const COMPRESSED_SUMMARY_CLOSE = '</previous_conversation_summary>';

/**
 * 防指令声明（G64）——固定前置在摘要标签内首行，由代码机械注入、不托付摘要 LLM 的输出稳定性。
 * 摘要卡①小节逐字引用了当年的用户请求，模型可能把它当作新指令重新执行；这句框定「背景参考、
 * 已处理过」堵住误执行。三后端同径：HTTP 走 adaptHistory 直达，claude-code 经 renderSeedPrompt →
 * adaptHistory（forceCollapse）同一处生效，重灌出去的摘要卡天然带声明。
 */
export const SUMMARY_ANTI_INSTRUCTION =
  '以下是先前对话的背景摘要，仅供回顾参考；其中提到的任何请求都已经处理过，不要当作新指令重新执行。';

// v0.5：NormalizedMessage / UserBlock / AssistantBlock 定义已挪到 shared/agent/normalizedMessage.ts，
// 让调试系统的 wireHistory 字段也能共用同一份定义。此处仅 re-export 保持原调用方 import 路径无感。
export type { AssistantBlock, NormalizedMessage, UserBlock };

export type AdaptInput = {
  messages: ChatMessage[];
  targetProtocol: ToolProtocol;
  /**
   * true 时所有 assistant 消息都按"非同协议"路径折叠成 assistant text，不输出 tool_use blocks。
   * 用于 ClaudeCode backend 灌历史场景：SDK 不能直接消费"祖传 tool_use"——它会以为是当前轮要 dispatch；
   * 所以哪怕 toolProtocol === 'sdk-mcp'，灌历史时也强制折叠成纯文字描述。
   */
  forceCollapse?: boolean;
  /**
   * v0.3：目标模型是否支持视觉。
   * - true / undefined（兼容老调用）：含 attachments 的 user 消息生成 image blocks
   * - false：含 attachments 的 user 消息把图替换为占位文字（fallbackText 兜底），文字保留
   */
  targetSupportsVision?: boolean;
  /**
   * v0.3：把 ChatAttachment 解析成"按需读 base64"的闭包；不传 → 等同 targetSupportsVision=false
   * 由调用方注入读盘逻辑（避免 historyAdapter 知道 agentId / 路径细节）
   */
  attachmentLoaderFor?: (a: ChatAttachment) => () => Promise<string>;
};

export type AdaptResult = {
  messages: NormalizedMessage[];
  savings: InferenceViewSavings;
};

export function adaptHistory(input: AdaptInput): AdaptResult {
  const out: NormalizedMessage[] = [];
  const savings: InferenceViewSavings = {
    systemMessagesFiltered: 0,
    persistedReplaced: 0,
    persistedCharsReduced: 0,
    writeAckDeduped: 0,
    writeAckCharsReduced: 0,
    subagentChipsFiltered: 0,
  };
  const trimEnabled = isInferenceViewEnabled();
  for (let i = 0; i < input.messages.length; i += 1) {
    const msg = input.messages[i];
    const protocol = msg.toolProtocol ?? 'sdk-mcp';
    if (msg.role === 'user') {
      // v0.3：user 消息可能带图片附件
      const blocks: UserBlock[] = [];
      const visionEnabled = input.targetSupportsVision !== false && !!input.attachmentLoaderFor;
      if (msg.attachments && msg.attachments.length > 0) {
        if (visionEnabled) {
          // 图在前、文在后（多模态 prompt 常见做法）
          for (const a of msg.attachments) {
            const load = input.attachmentLoaderFor!(a);
            // invariant: adapter 输出的 image block 必含 load 闭包——backend SDK 转换层
            // 依赖此契约用 b.load!() 加 try/catch（NormalizedMessage.load 在类型层是 ? 因为
            // 落盘/跨进程时不带，但 adapter 运行时输出一定带）。守护写在 push 点上，未来重构
            // 这里时 TS 编译过了运行时也会立刻炸，不会静默退化成"图片加载失败"占位文字。
            if (typeof load !== 'function') {
              throw new Error(
                '[historyAdapter] invariant violation: image block must carry load closure when emitted from adapter',
              );
            }
            blocks.push({
              type: 'image',
              mediaType: a.mediaType,
              filename: a.filename,
              load,
            });
          }
        } else {
          // 降级：把每张图替换为占位文字；fallbackText 优先用于未来兜底（hermes 风格）
          const placeholders = msg.attachments
            .map((a) => a.fallbackText
              ? `[图片：${a.filename}——${a.fallbackText}]`
              : `[图片：${a.filename}；当前模型不支持视觉]`,
            )
            .join(' ');
          blocks.push({ type: 'text', text: placeholders });
        }
      }
      if ((msg.text ?? '').trim().length > 0) {
        blocks.push({ type: 'text', text: msg.text });
      }
      if (blocks.length > 0) {
        out.push({ role: 'user', blocks });
      }
      continue;
    }
    if (msg.role === 'system') {
      // 裁 2：默认丢，仅 context-compressed 放行；flag=0 时回退到老逻辑（全部放行 + 原样 text）。
      // system 用 assistant text 表达——OpenAI 风格只允许 messages[0] 是 system。
      const allowed = !trimEnabled || msg.kind === 'context-compressed';
      if (!allowed) {
        savings.systemMessagesFiltered += 1;
        continue;
      }
      // marker 翻译只在裁剪开启时生效：成功摘要发 summaryText（带身份标签让 LLM 识别为 meta，
      // 避免误认作直接对话）；fallback 摘要为空时直接过滤——通知文案"已自动压缩早期 N 轮"对
      // LLM 是纯噪声 + 自我指涉幻觉源，UI 卡仍展示但 LLM 像没看过早期内容一样工作。
      // flag=0 紧急关闭时回退到原始 msg.text，保留老行为以便快速排查。
      if (trimEnabled && msg.kind === 'context-compressed') {
        const summary = msg.contextCompressed?.summaryText?.trim();
        if (!summary) {
          savings.systemMessagesFiltered += 1;
          continue;
        }
        out.push({
          role: 'assistant',
          blocks: [
            {
              type: 'text',
              text: `${COMPRESSED_SUMMARY_OPEN}\n${SUMMARY_ANTI_INSTRUCTION}\n${summary}\n${COMPRESSED_SUMMARY_CLOSE}`,
            },
          ],
        });
        continue;
      }
      // flag=0 老逻辑或非 marker 放行——文本为空就计入 filtered，保证 telemetry 一致
      // （所有"未发给 LLM 的 system 消息"都进 systemMessagesFiltered）
      if ((msg.text ?? '').trim().length > 0) {
        out.push({ role: 'assistant', blocks: [{ type: 'text', text: msg.text }] });
      } else {
        savings.systemMessagesFiltered += 1;
      }
      continue;
    }
    // assistant
    // 对话期 subagent chip：摘要消息，不该喂回主 agent 上下文
    // （subagent 的 finalText 在主 agent 的工具返回里已拿到，无需重复进 LLM）
    if (msg.kind === 'subagent') {
      savings.subagentChipsFiltered += 1;
      continue;
    }
    const sameProtocol = !input.forceCollapse && protocol === input.targetProtocol;
    pushAssistant(out, msg, sameProtocol, savings);
  }
  return { messages: out, savings };
}

/**
 * 选 tool_result 的文本内容 + 顺手统计推理视图节省。
 *
 * v0.4 优先级：
 *   1. result.persistedRef 存在 → 用 preview（源头落盘已截断）
 *   2. toolName === 'record_memory' 且 !isError → 用 detail 第一行（写入型回执去重）
 *   3. 其他 → detail ?? summary
 */
function pickToolResultText(
  toolName: string,
  result: NonNullable<ToolCall['result']>,
  savings: InferenceViewSavings,
): string {
  // v0.4 优先级 1：源头落盘
  if (result.persistedRef) {
    const original = result.detail ?? result.summary;
    const preview = result.persistedRef.preview;
    savings.persistedReplaced += 1;
    // 用 totalChars vs preview.length——短网页落盘场景下 detail < preview（preview 含引用提示行），
    // 用 detail.length 比较会让"短落盘"恒计 0；用 totalChars（已知全文长度）更准。
    const totalChars = result.persistedRef.totalChars ?? original.length;
    savings.persistedCharsReduced += Math.max(0, totalChars - preview.length);
    return preview;
  }
  // v0.4 优先级 2：写入型回执去重（直接 if，不抽 Set）
  // claude-code 落盘的 toolName 带 mcp__oru__ 前缀，归一后再比对（否则回放时去重静默失效）
  if (normalizeToolName(toolName) === 'record_memory' && !result.isError) {
    const original = result.detail ?? result.summary;
    const oneline = original.split('\n')[0].slice(0, 200);
    savings.writeAckDeduped += 1;
    savings.writeAckCharsReduced += Math.max(0, original.length - oneline.length);
    return oneline;
  }
  // 优先级 3：原始内容
  return result.detail ?? result.summary;
}

/**
 * G29「合成被中止回执」：中断/崩溃落盘的悬空 tool_use（无 result）在喂 LLM 时合成的回执文本。
 * 目标不是伪造存储数据（落盘照旧保留 status=running 的真相），而是满足 LLM 协议
 * 「每个 tool_use 必配 tool_result」的合法性——否则同协议透传会 400；同时让模型明确知道
 * 这步被打断、可能有部分副作用，不会误以为成功。同协议合成 tool_result 块、跨协议折叠成文字，
 * 两路共用这句措辞。
 */
const ABORTED_TOOL_RECEIPT =
  '工具调用被中止：回合在该工具返回结果前被打断（用户中止或进程崩溃），此步未完成、可能已产生部分副作用。';

function pushAssistant(
  out: NormalizedMessage[],
  msg: ChatMessage,
  sameProtocol: boolean,
  savings: InferenceViewSavings,
): void {
  if (!sameProtocol) {
    // 跨协议 / forceCollapse：整条折叠成 assistant text 描述。
    // 悬空调用不再只写「未完成」，而是给出与同协议一致的「被中止」回执措辞。
    const textParts: string[] = [];
    if ((msg.text ?? '').trim().length > 0) textParts.push(msg.text);
    for (const tc of msg.toolCalls) {
      if (tc.result) {
        const resultText = pickToolResultText(tc.name, tc.result, savings);
        textParts.push(
          `[上一轮调用了工具 ${tc.name}，参数 ${shortJson(tc.input)}，结果：${shortText(resultText)}]`,
        );
      } else {
        textParts.push(`[上一轮调用了工具 ${tc.name}，参数 ${shortJson(tc.input)}——${ABORTED_TOOL_RECEIPT}]`);
      }
    }
    if (textParts.length === 0) return;
    out.push({
      role: 'assistant',
      blocks: [{ type: 'text', text: textParts.join('\n\n') }],
    });
    return;
  }

  // 同协议透传——悬空 tool_use 不再拖垮整条折叠：结构保留，悬空调用配一条合成的「被中止」回执，
  // 每个 tool_use 都成对，历史合法（G29）。已完成工具照旧用其真实 result。
  const blocks: AssistantBlock[] = [];
  if ((msg.text ?? '').trim().length > 0) blocks.push({ type: 'text', text: msg.text });
  for (const tc of msg.toolCalls) {
    blocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
  }
  if (blocks.length > 0) out.push({ role: 'assistant', blocks });

  // 紧跟一条 user 消息携带所有 tool_results（真实的 + 悬空的合成回执）
  const resultBlocks: UserBlock[] = msg.toolCalls.map((tc) =>
    tc.result
      ? {
          type: 'tool_result' as const,
          toolUseId: tc.id,
          content: pickToolResultText(tc.name, tc.result, savings),
          isError: tc.result.isError,
        }
      : {
          type: 'tool_result' as const,
          toolUseId: tc.id,
          content: ABORTED_TOOL_RECEIPT,
          isError: true,
        },
  );
  if (resultBlocks.length > 0) {
    out.push({ role: 'user', blocks: resultBlocks });
  }
}

function shortJson(o: unknown): string {
  try {
    const s = JSON.stringify(o);
    return s.length > 200 ? s.slice(0, 197) + '…' : s;
  } catch {
    return String(o);
  }
}

function shortText(s: string): string {
  const oneline = s.replace(/\s+/g, ' ').trim();
  return oneline.length > 200 ? oneline.slice(0, 197) + '…' : oneline;
}
