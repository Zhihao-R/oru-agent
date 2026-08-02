/**
 * G64 摘要卡固定分节 + 防指令声明。
 *
 * 分工按「能不能信 LLM 自觉」划：分节由 prompt 要求（buildSummaryPrompt），声明由代码机械注入
 * （historyAdapter marker 翻译）。本文件两半分别断言：
 *   1. prompt 含四个固定小节标题 + currentUserRequest 逐字引用要求。
 *   2. 摘要卡翻成 assistant text 时，声明行固定前置在标签内首行——不依赖摘要 LLM 的输出内容。
 *   3. fallback 空摘要仍被过滤（回归，不因加声明而放行空卡）。
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/types';
import { buildSummaryPrompt } from '../../electron/main/agent/context/summaryPrompt';
import {
  adaptHistory,
  SUMMARY_ANTI_INSTRUCTION,
} from '../../electron/main/agent/backends/historyAdapter';

function extractText(blocks: { type: string; text?: string }[]): string {
  return blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

describe('G64 摘要 prompt 固定分节', () => {
  it('含四个固定小节 + currentUserRequest 逐字引用要求', () => {
    const prompt = buildSummaryPrompt({
      previousSummary: '',
      toCompress: [
        { id: 'u1', conversationId: 'c', role: 'user', text: '第一条', toolCalls: [], createdAt: 0, done: true },
      ],
      currentUserRequest: '把配置里的超时改成 30 秒',
    });
    expect(prompt).toContain('① 当前任务');
    expect(prompt).toContain('② 已完成动作');
    expect(prompt).toContain('③ 关键决定');
    expect(prompt).toContain('④ 未决问题');
    // 逐字引用：当前任务原文出现在 prompt 里，且要求逐字引用而非转述
    expect(prompt).toContain('把配置里的超时改成 30 秒');
    expect(prompt).toContain('逐字引用');
  });

  it('递增：有旧摘要时仍要求按四节重写', () => {
    const prompt = buildSummaryPrompt({
      previousSummary: '① 当前任务：旧任务\n② ...',
      toCompress: [],
      currentUserRequest: '新请求',
    });
    expect(prompt).toContain('仍按四个小节重写');
  });
});

describe('G64 防指令声明机械注入', () => {
  const compressedMsg = (summaryText: string): ChatMessage => ({
    id: 's1',
    conversationId: 'c',
    role: 'system',
    kind: 'context-compressed',
    text: 'UI 通知文案',
    toolCalls: [],
    createdAt: 0,
    done: true,
    contextCompressed: {
      compressedMessageIds: ['x'],
      summaryText,
      fallback: false,
    },
  });

  it('声明行固定前置在标签内首行，位于摘要正文之前', () => {
    const { messages } = adaptHistory({
      messages: [compressedMsg('① 当前任务：做了 X\n② 已完成：改了 a.ts')],
      targetProtocol: 'anthropic',
    });
    expect(messages).toHaveLength(1);
    const text = extractText(messages[0].blocks as { type: string; text?: string }[]);
    expect(text).toContain(SUMMARY_ANTI_INSTRUCTION);
    // 声明在摘要正文之前
    expect(text.indexOf(SUMMARY_ANTI_INSTRUCTION)).toBeLessThan(text.indexOf('① 当前任务'));
    // 仍包在 previous_conversation_summary 标签内
    expect(text).toContain('<previous_conversation_summary>');
  });

  it('注入不依赖摘要内容——摘要本身不含声明时也前置', () => {
    const { messages } = adaptHistory({
      messages: [compressedMsg('随便一段不含任何声明的摘要')],
      targetProtocol: 'anthropic',
    });
    const text = extractText(messages[0].blocks as { type: string; text?: string }[]);
    expect(text).toContain(SUMMARY_ANTI_INSTRUCTION);
  });

  it('回归：fallback 空摘要仍被过滤，不因加声明而放行空卡', () => {
    const { messages, savings } = adaptHistory({
      messages: [compressedMsg('   ')],
      targetProtocol: 'anthropic',
    });
    expect(messages).toHaveLength(0);
    expect(savings.systemMessagesFiltered).toBe(1);
  });
});
