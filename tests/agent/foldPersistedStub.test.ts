/**
 * G65 折叠占位区分落盘与否 + G103 bash 落盘策略。
 *
 * - 有 persistedRef → 桩带路径「已落盘，read_file 可取回」；无 → 原桩「取不回、重新调用」。
 * - 带路径桩与 persist.ts buildPreview 的引导行共用同一 readFileHint helper（改一处两处同变）。
 * - 桩是消息的确定性函数（同输入两次折叠逐字节相等）——S16 水印重建不受影响。
 * - 折叠必缩短：落盘结果极短 + 长路径也不会折成更长（直接比对兜底）。
 * - bash persistPolicy='always'（命令输出不可重现，与 web_fetch 同类）。
 * - Task persistPolicy='always'（subagent 输出不可重现——中等长度结果若不落盘，折叠后
 *   桩里没有取回路径，逐字原文对模型永久丢失，只能凭记忆重构）。
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage, ToolCall } from '@shared/types';
import {
  applyFoldingByWatermark,
  computeFoldWatermark,
} from '../../electron/main/agent/context/applyTier1Folding';
import { readFileHint } from '../../electron/main/agent/context/persist';
import { makeBashTool } from '../../electron/main/agent/agentTools/bash';
import { makeTaskTool } from '../../electron/main/agent/agentTools/task';

const applyFold = (h: ChatMessage[]): ChatMessage[] =>
  applyFoldingByWatermark(h, computeFoldWatermark(h));

function mkUser(id: string): ChatMessage {
  return { id, conversationId: 'c', role: 'user', text: 'hi', toolCalls: [], createdAt: 0, done: true };
}
function mkAsst(id: string, toolCalls: ToolCall[]): ChatMessage {
  return { id, conversationId: 'c', role: 'assistant', text: '', toolCalls, createdAt: 0, done: true };
}
function mkTool(id: string, result: ToolCall['result'], name = 'bash'): ToolCall {
  return { id, name, input: {}, status: 'success', result };
}

// 折叠窗保留最近 3 轮 user——放 5 轮 user，让最早的 asst 工具回执落在折叠区。
function historyWith(oldToolResult: ToolCall['result']): ChatMessage[] {
  return [
    mkUser('u1'),
    mkAsst('a1', [mkTool('t1', oldToolResult)]),
    mkUser('u2'),
    mkUser('u3'),
    mkUser('u4'),
    mkUser('u5'),
  ];
}

describe('G65 折叠占位区分落盘与否', () => {
  it('无 persistedRef → 原桩「取不回、重新调用」', () => {
    const folded = applyFold(historyWith({ toolCallId: 't1', isError: false, summary: 's', detail: 'x'.repeat(500) }));
    const stub = folded[1].toolCalls[0].result!.detail;
    expect(stub).toContain('需要原文请重新调用');
    expect(stub).not.toContain('read_file');
  });

  it('有 persistedRef → 桩带路径 + read_file 引导，preview 同步替换', () => {
    const path = '/Users/x/.oru/conversations/a/c-tool-cache/t1.txt';
    const folded = applyFold(
      historyWith({
        toolCallId: 't1',
        isError: false,
        summary: 's',
        detail: 'y'.repeat(1200),
        persistedRef: { path, totalChars: 9999, preview: 'y'.repeat(1200) + '\n\n[...]' },
      }),
    );
    const result = folded[1].toolCalls[0].result!;
    expect(result.detail).toContain('已落盘');
    expect(result.detail).toContain('9999');
    expect(result.detail).toContain(readFileHint(path)); // 共用 helper 的引导句
    // preview 与 detail 同步折成同一个桩
    expect(result.persistedRef!.preview).toBe(result.detail);
  });

  it('桩是消息的确定性函数——同输入两次折叠逐字节相等', () => {
    const h = historyWith({
      toolCallId: 't1',
      isError: false,
      summary: 's',
      detail: 'z'.repeat(800),
      persistedRef: { path: '/p/t1.txt', totalChars: 800, preview: 'z'.repeat(800) },
    });
    const a = applyFold(h);
    const b = applyFold(h);
    expect(a[1].toolCalls[0].result!.detail).toBe(b[1].toolCalls[0].result!.detail);
  });

  it('折叠必缩短：极短落盘结果 + 长路径也不折成更长', () => {
    const longPath = '/Users/someone/.oru/users/uid/conversations/agent-abc/conv-xyz-tool-cache/' + 'toolu_'.repeat(10) + '.txt';
    // preview 极短（内容才 5 字），但 currentContentSize 因长路径过 MIN_FOLD_BYTES 门槛
    const shortPreview = 'abcde\n\n[内容已落盘；全文 5 字符，' + readFileHint(longPath) + ']';
    const h = historyWith({
      toolCallId: 't1',
      isError: false,
      summary: 's',
      detail: 'abcde',
      persistedRef: { path: longPath, totalChars: 5, preview: shortPreview },
    });
    const folded = applyFold(h);
    const after = folded[1].toolCalls[0].result!.persistedRef!.preview;
    // 折不缩短就不折——原样保留，绝不换成更长的桩
    expect(after.length).toBeLessThanOrEqual(shortPreview.length);
  });
});

describe('G103 bash 落盘策略', () => {
  it("persistPolicy='always'（命令输出不可重现，无论大小都落盘）", () => {
    expect(makeBashTool().persistPolicy).toBe('always');
  });
});

describe('ask_user_choice 豁免折叠', () => {
  // 用户亲笔回答不可再生（折叠桩的「重新调用」＝把答过的问题再问一遍），且通常短、
  // 长即重要——豁免 Tier 1 折叠，待遇与用户打字的 user 消息对齐（仅随 Tier 2 整段摘要）。
  const longAnswer = {
    toolCallId: 't1',
    isError: false,
    summary: 's',
    detail: '预算：（我自己说）' + '这一段是用户亲笔的长回答。'.repeat(30),
  };

  it('超 150 字符的回答落在折叠区也不折，原文保留', () => {
    const h = [
      mkUser('u1'),
      mkAsst('a1', [mkTool('t1', longAnswer, 'ask_user_choice')]),
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
      mkUser('u5'),
    ];
    expect(applyFold(h)[1].toolCalls[0].result!.detail).toBe(longAnswer.detail);
  });

  it('claude-code 前缀名 mcp__oru__ask_user_choice 同样豁免（归一后匹配）', () => {
    const h = [
      mkUser('u1'),
      mkAsst('a1', [mkTool('t1', longAnswer, 'mcp__oru__ask_user_choice')]),
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
      mkUser('u5'),
    ];
    expect(applyFold(h)[1].toolCalls[0].result!.detail).toBe(longAnswer.detail);
  });
});

describe('Task 落盘策略', () => {
  it("persistPolicy='always'（subagent 输出不可重现，无论大小都落盘）", () => {
    // 'auto' 下 150B~2k token 区间是有损盲区：会折叠但不落盘，桩写「取不回、重新调用」，
    // 而 subagent 重跑拿到的是另一次 LLM 输出，不是原文。'always' 分支逻辑本身由
    // __smoke_persist__ 覆盖，这里只挡「policy 被改回 auto」的回归。
    expect(makeTaskTool().persistPolicy).toBe('always');
  });
});
