/**
 * historyAdapter 写入型回执去重在带前缀工具名下的回归。
 *
 * 目标问题：claude-code 后端落盘的 toolCall.name 带 mcp__oru__ 前缀，
 * pickToolResultText 按裸名 'record_memory' 精确匹配——前缀名下去重静默失效，
 * 回放历史时整段回执原样喂给 LLM。修复 = 匹配前归一工具名。
 *
 * 不打 LLM。record_memory 去重不受 ORU_INFERENCE_VIEW 开关控制之外的隐性开关影响，
 * 但按测试约定仍显式设置，不依赖环境默认值。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { adaptHistory } from '../../electron/main/agent/backends/historyAdapter';
import type { ChatMessage, ToolCall } from '../../shared/types';

beforeEach(() => {
  process.env.ORU_INFERENCE_VIEW = '1'; // 显式开启，不靠"恰好没设"
});

function recordMemoryTurn(toolName: string): ChatMessage {
  const toolCalls: ToolCall[] = [
    {
      id: 't1',
      name: toolName,
      input: { content: '用户偏好深色主题' },
      status: 'success',
      startedAt: 1,
      result: {
        toolCallId: 't1',
        isError: false,
        summary: '已记录',
        detail: '已记录 1 条记忆\n- 详情行A\n- 详情行B',
      },
    },
  ];
  return {
    id: 'a1',
    conversationId: 'c1',
    role: 'assistant',
    text: '记下了',
    toolCalls,
    createdAt: 1,
    done: true,
    backendType: 'claude-code',
    toolProtocol: 'sdk-mcp',
  };
}

function collapsedText(msg: ChatMessage): string {
  // sdk-mcp → anthropic-native 跨协议：折叠成 assistant text，回执经 pickToolResultText
  const { messages } = adaptHistory({
    messages: [msg],
    targetProtocol: 'anthropic-native',
  });
  return messages
    .map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''))
    .join('\n');
}

describe('record_memory 回执去重 · 工具名前缀归一', () => {
  it('裸名：回执折叠到第一行（既有行为）', () => {
    const text = collapsedText(recordMemoryTurn('record_memory'));
    expect(text).toContain('已记录 1 条记忆');
    expect(text).not.toContain('详情行A');
  });

  it('带 mcp__oru__ 前缀（claude-code 落盘名）：同样去重（回归）', () => {
    const text = collapsedText(recordMemoryTurn('mcp__oru__record_memory'));
    expect(text).toContain('已记录 1 条记忆');
    expect(text).not.toContain('详情行A');
  });

  it('attacker：外部 MCP 同名工具（mcp__other__record_memory）不享受 Oru 工具的去重', () => {
    const text = collapsedText(recordMemoryTurn('mcp__other__record_memory'));
    expect(text).toContain('详情行A'); // 原样保留，不被冒充
  });
});
