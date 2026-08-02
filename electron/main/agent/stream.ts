import type { ServerEventPayload } from '@shared/protocol';
import { normalizeToolName } from '@shared/agent/toolName';
import type { ToolCall, ToolResult } from '@shared/types';
import type { EngineEvent } from '../engine';
import { getToolByName } from './backends/factory';
import { shouldPersist, writeToolCacheFile, buildPreview } from './context/persist';
import { takeToolVisual } from './agentTools/toolVisuals';
import { takeToolStructured } from './agentTools/toolStructured';
import { stringifyToolResultContent } from './toolResultText';
import type { PartialTurn } from './interrupted';

/**
 * 跑一次引擎事件流，丢弃中间事件、只取累加的结果文本
 * 用于 askTwinBridge / taskAnnouncer 起背景 Twin query 这种"问完即走"的场景
 */
export async function runQueryOnce(
  events: AsyncIterable<EngineEvent>,
): Promise<{ resultText: string; isError: boolean }> {
  let assembled = '';
  let resultText = '';
  let isError = false;
  for await (const ev of events) {
    if (ev.type === 'assistant_text') {
      assembled += ev.text;
    } else if (ev.type === 'result') {
      if (ev.resultText) resultText = ev.resultText;
      if (ev.isError) isError = true;
    }
  }
  return { resultText: assembled || resultText, isError };
}

type Emit = (ev: ServerEventPayload) => void;

type StreamCtx = {
  conversationId: string;
  messageId: string;
  /** v0.4 源头落盘：当前对话归属的 owner 和 agent；用于拼 .tool-cache/ 路径 */
  ownerId: string;
  agentId: string;
  emit: Emit;
  /** 引擎给出新的 session_id 时回调（首次或 compact 后）；null=作废（G112/G54 弃号重灌） */
  onSdkSessionId?: (sid: string | null) => Promise<void>;
  /**
   * 每次把已成形产出同步进 partial 后回调——供 runner 节流镜像流式草稿（S03 崩溃恢复）。
   * fire-and-forget，内部自节流；不传（背景 query 等无需崩溃恢复的场景）= 无副作用。
   */
  onPartialUpdate?: () => void;
};

/**
 * 把引擎事件流转换为 WS 事件流（主对话用）
 *
 * 同时把 'session' 事件回写到 conversation 持久层。
 * 返回值额外带 toolCalls 数组——给 router 落盘时填到 ChatMessage.toolCalls，
 * 这样 history replay 时 historyAdapter 能拿到完整的工具调用 + 结果。
 */
export async function pipeSdkToEvents(
  events: AsyncIterable<EngineEvent>,
  ctx: StreamCtx,
  partial?: PartialTurn,
): Promise<{ resultText: string; isError: boolean; toolCalls: ToolCall[]; sawReasoning: boolean }> {
  const toolCalls = new Map<string, ToolCall>();
  let assembled = '';
  let isError = false;
  let resultText = '';
  let sawReasoning = false;

  for await (const ev of events) {
    switch (ev.type) {
      case 'session': {
        if (ctx.onSdkSessionId) {
          try {
            await ctx.onSdkSessionId(ev.sessionId);
          } catch {
            // 写盘失败不阻断流式输出
          }
        }
        break;
      }
      case 'assistant_text': {
        assembled += ev.text;
        ctx.emit({
          type: 'chat.delta',
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
          delta: { textChunk: ev.text },
        });
        break;
      }
      case 'retrying': {
        ctx.emit({
          type: 'chat.retrying',
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
          attempt: ev.attempt,
          maxRetries: ev.maxRetries,
        });
        break;
      }
      case 'tool_use': {
        const tc: ToolCall = {
          id: ev.id,
          name: ev.name,
          input: ev.input,
          status: 'running',
          startedAt: Date.now(),
          // 盖时序戳：此刻前面已积累的文本长度，供渲染层把工具卡插回文本中间
          textOffset: assembled.length,
        };
        toolCalls.set(ev.id, tc);
        ctx.emit({
          type: 'chat.toolCall',
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
          tool: tc,
        });
        break;
      }
      case 'tool_result': {
        const matched = toolCalls.get(ev.toolUseId);
        // claude-code 事件名带 mcp__oru__ 前缀，而 stash 键 / 工具 registry 用裸名——归一后再查，
        // 否则该后端下 stash 恒 miss、persistPolicy 静默退化（外部 MCP 工具名不归一，原样查 registry）。
        const bareName = matched ? normalizeToolName(matched.name) : undefined;
        const detail = stringifyToolResultContent(ev.content);
        const result: ToolResult = {
          toolCallId: ev.toolUseId,
          isError: ev.isError,
          summary: summarize(detail),
          detail,
          // claude-code 后端 structured 不流经 MCP（ev.structured 为空）→ 从 toolStructured 桥兜底取，
          // 与下方 takeToolVisual 同源（见 toolStructured.ts）。anthropic/openai 走 ev.structured，不 take。
          structured:
            ev.structured ??
            (matched && bareName
              ? takeToolStructured(ctx.conversationId, bareName, matched.input)
              : undefined),
        };
        // v0.4：工具结果源头落盘——detail 超阈值 / 永远落盘的工具 → 写盘并填 persistedRef
        const tool = bareName ? getToolByName(bareName) : undefined;
        if (shouldPersist(tool, detail)) {
          try {
            const ext = tool?.persistExt ?? 'txt';
            const path = await writeToolCacheFile({
              ownerId: ctx.ownerId,
              agentId: ctx.agentId,
              conversationId: ctx.conversationId,
              callId: ev.toolUseId,
              ext,
              content: detail,
            });
            result.persistedRef = {
              path,
              totalChars: detail.length,
              preview: buildPreview(detail, path),
            };
          } catch (e) {
            // 写盘失败：fallback 走"不落盘 detail 原样发给 LLM"路径
            // tech doc §7.2：当轮 LLM 仍能看到完整内容；下轮可能因撞窗口被压缩
            console.warn('[persist] write tool cache failed', e);
          }
        }
        if (matched) {
          matched.status = result.isError ? 'error' : 'success';
          matched.finishedAt = Date.now();
          matched.result = result;
          // 决策 8：图片工具 execute 落盘缩略图/落地图后 stash 的视觉数据，按 (conv,name,input) 取出挂卡。
          const visual = takeToolVisual(ctx.conversationId, bareName ?? matched.name, matched.input);
          if (visual) matched.visual = visual;
        }
        ctx.emit({
          type: 'chat.toolResult',
          conversationId: ctx.conversationId,
          messageId: ctx.messageId,
          result,
        });
        break;
      }
      case 'result': {
        if (ev.resultText) {
          resultText = ev.resultText;
          // 如果之前没拼到任何文本（小概率：模型只用了 tool），把 result 兜底当作 final delta
          if (!assembled && resultText) {
            ctx.emit({
              type: 'chat.delta',
              conversationId: ctx.conversationId,
              messageId: ctx.messageId,
              delta: { textChunk: resultText },
            });
            assembled = resultText;
          }
        }
        if (ev.isError) isError = true;
        if (ev.sawReasoning) sawReasoning = true;
        break;
      }
    }

    // 中断恢复：每处理完一个事件就把已成形的产出同步到 partial。
    // 一旦 events 在下一次迭代抛错（idle-timeout / abort），caller 仍能从 partial 取到断点前的内容。
    if (partial) {
      partial.resultText = assembled || resultText;
      partial.toolCalls = Array.from(toolCalls.values());
      // 已成形产出同步进 partial 后镜像草稿（节流在 writer 内部）——崩溃时凭它补回本轮。
      ctx.onPartialUpdate?.();
    }
  }

  ctx.emit({ type: 'chat.done', conversationId: ctx.conversationId, messageId: ctx.messageId });
  return {
    resultText: assembled || resultText,
    isError,
    // 流结束时整体导出累积的 toolCalls 数组（含 result），给 router 落盘
    toolCalls: Array.from(toolCalls.values()),
    sawReasoning,
  };
}


function summarize(detail: string): string {
  const oneline = detail.replace(/\s+/g, ' ').trim();
  return oneline.length > 120 ? oneline.slice(0, 117) + '...' : oneline;
}
