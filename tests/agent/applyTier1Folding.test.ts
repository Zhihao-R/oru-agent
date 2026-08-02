/**
 * applyTier1Folding 单元测试
 *
 * 验证：
 * - 短对话不折叠
 * - 超 keepRecentRounds 轮的 tool_result 被折叠为桩
 * - 最近 keepRecentRounds 轮原样保留
 * - detail < MIN_FOLD_BYTES 不折叠
 * - plugin-activate 白名单 kind 不折叠
 * - isError=true 工具结果也折叠
 * - persistedRef.preview 与 detail 同步替换
 * - toolCall.result undefined 时跳过、不抛错
 * - 入参不被修改（immutable）
 */
import { describe, expect, it } from 'vitest';
import {
  applyFoldingByWatermark,
  computeFoldWatermark,
} from '../../electron/main/agent/context/applyTier1Folding';
import type { ChatMessage, ChatMessageKind, ToolCall } from '../../shared/types';

// 折叠规则回归——旧「每轮滑动折叠」= 按当前折叠窗边界水印折叠。规则本身（MIN_FOLD_BYTES /
// 白名单 / 只折 tool result / immutable）不变，只是折叠边界从每轮重算改由水印给定。
const applyTier1Folding = (h: ChatMessage[]): ChatMessage[] =>
  applyFoldingByWatermark(h, computeFoldWatermark(h));

const FOLD_STUB = '[早期结果已折叠，需要原文请重新调用]';
/** 实测 150 字符门槛——必须比 FOLD_STUB 长，否则折叠失去意义。 */
const BIG_DETAIL = 'x'.repeat(2000);
/** 比 MIN_FOLD_BYTES=150 短一截，模拟"小工具结果不折叠"分支。 */
const SMALL_DETAIL = 'y'.repeat(80);

function mkUser(id: string, text = 'hi'): ChatMessage {
  return { id, conversationId: 'c', role: 'user', text, toolCalls: [], createdAt: 0, done: true };
}

function mkAsst(id: string, toolCalls: ToolCall[] = [], kind?: ChatMessageKind): ChatMessage {
  return {
    id,
    conversationId: 'c',
    role: 'assistant',
    text: '',
    toolCalls,
    createdAt: 0,
    done: true,
    ...(kind ? { kind } : {}),
  };
}

function mkTool(opts: {
  id?: string;
  name?: string;
  detail?: string;
  preview?: string;
  isError?: boolean;
}): ToolCall {
  const detail = opts.detail ?? BIG_DETAIL;
  return {
    id: opts.id ?? 'tc1',
    name: opts.name ?? 'read_file',
    input: {},
    status: 'completed',
    startedAt: 0,
    finishedAt: 1,
    result: {
      toolCallId: opts.id ?? 'tc1',
      isError: opts.isError ?? false,
      summary: 'short summary',
      detail,
      ...(opts.preview
        ? { persistedRef: { path: '/x', totalChars: detail.length, preview: opts.preview } }
        : {}),
    },
  };
}

describe('applyTier1Folding', () => {
  it('短对话（user ≤ 3）不折叠', () => {
    // 3 user，硬编码 KEEP_RECENT_ROUNDS=3 → 全部保留
    const h: ChatMessage[] = [
      mkUser('u1'),
      mkAsst('a1', [mkTool({ id: 't1' })]),
      mkUser('u2'),
      mkAsst('a2', [mkTool({ id: 't2' })]),
      mkUser('u3'),
    ];
    const out = applyTier1Folding(h);
    expect(out).toBe(h); // 引用相等：早退路径
  });

  it('超 3 轮的 tool_result 折叠，最近 3 轮原样', () => {
    // 5 user，硬编码 KEEP_RECENT_ROUNDS=3 → 前 2 user + 紧随的 assistant 应被折叠
    const h: ChatMessage[] = [
      mkUser('u1'),
      mkAsst('a1', [mkTool({ id: 't1' })]), // 应折叠
      mkUser('u2'),
      mkAsst('a2', [mkTool({ id: 't2' })]), // 应折叠
      mkUser('u3'),
      mkAsst('a3', [mkTool({ id: 't3' })]), // 保留
      mkUser('u4'),
      mkAsst('a4', [mkTool({ id: 't4' })]), // 保留
      mkUser('u5'),
    ];
    const out = applyTier1Folding(h);
    expect(out[1].toolCalls[0].result?.detail).toBe(FOLD_STUB);
    expect(out[3].toolCalls[0].result?.detail).toBe(FOLD_STUB);
    expect(out[5].toolCalls[0].result?.detail).toBe(BIG_DETAIL);
    expect(out[7].toolCalls[0].result?.detail).toBe(BIG_DETAIL);
  });

  it('detail < MIN_FOLD_BYTES 不折叠', () => {
    const h: ChatMessage[] = [
      mkUser('u1'),
      mkAsst('a1', [mkTool({ id: 't1', detail: SMALL_DETAIL })]),
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
    ];
    const out = applyTier1Folding(h);
    // assistant a1 在折叠区，但 detail 长度 200 < 600，不应被折叠
    expect(out[1].toolCalls[0].result?.detail).toBe(SMALL_DETAIL);
    // foldMessage 检测到没有任何 toolCall 真折叠，返回原 msg
    expect(out[1]).toBe(h[1]);
  });

  it('kind=plugin-activate 白名单不折叠', () => {
    const tc = mkTool({ id: 't1' });
    const h: ChatMessage[] = [
      mkUser('u1'),
      mkAsst('a1', [tc], 'plugin-activate'),
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
    ];
    const out = applyTier1Folding(h);
    expect(out[1]).toBe(h[1]); // 整条 msg 原样返回
    expect(out[1].toolCalls[0].result?.detail).toBe(BIG_DETAIL);
  });

  it('isError 工具结果也折叠', () => {
    const h: ChatMessage[] = [
      mkUser('u1'),
      mkAsst('a1', [mkTool({ id: 't1', isError: true })]),
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
    ];
    const out = applyTier1Folding(h);
    expect(out[1].toolCalls[0].result?.detail).toBe(FOLD_STUB);
    expect(out[1].toolCalls[0].result?.isError).toBe(true); // isError 保留
  });

  it('G65 落盘结果折成带路径桩，preview 与 detail 同步', () => {
    const h: ChatMessage[] = [
      mkUser('u1'),
      mkAsst('a1', [
        mkTool({ id: 't1', detail: 'short', preview: 'x'.repeat(2000) }), // preview 撑过阈值
      ]),
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
    ];
    const out = applyTier1Folding(h);
    const result = out[1].toolCalls[0].result!;
    // 落过盘 → 带路径桩「已落盘、read_file 可取回」，不再是 FOLD_STUB
    expect(result.detail).toContain('已落盘');
    expect(result.detail).toContain('read_file');
    expect(result.detail).toContain('/x');
    // preview 与 detail 折成同一个桩
    expect(result.persistedRef?.preview).toBe(result.detail);
    // persistedRef 其他字段保留
    expect(result.persistedRef?.path).toBe('/x');
  });

  it('toolCall.result undefined 时跳过，不抛错', () => {
    const tc: ToolCall = {
      id: 'tc1',
      name: 'read_file',
      input: {},
      status: 'running',
      startedAt: 0,
    };
    const h: ChatMessage[] = [
      mkUser('u1'),
      mkAsst('a1', [tc]),
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
    ];
    const out = applyTier1Folding(h);
    expect(out[1].toolCalls[0].result).toBeUndefined();
  });

  it('折叠是 immutable —— 入参未被修改', () => {
    const tc = mkTool({ id: 't1' });
    const originalDetail = tc.result?.detail;
    const h: ChatMessage[] = [
      mkUser('u1'),
      mkAsst('a1', [tc]),
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
    ];
    applyTier1Folding(h);
    // 原 toolCall.result.detail 没被改
    expect(tc.result?.detail).toBe(originalDetail);
    // 原 history 数组没被改
    expect(h[1].toolCalls[0]).toBe(tc);
  });

  it('混合场景：折叠区有部分小 detail，部分大 detail → 只折叠大的', () => {
    const smallTc = mkTool({ id: 't-small', detail: SMALL_DETAIL });
    const bigTc = mkTool({ id: 't-big', detail: BIG_DETAIL });
    const h: ChatMessage[] = [
      mkUser('u1'),
      mkAsst('a1', [smallTc, bigTc]),
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
    ];
    const out = applyTier1Folding(h);
    // msg 被 clone（因为有部分折叠发生）
    expect(out[1]).not.toBe(h[1]);
    // 小的没改
    expect(out[1].toolCalls[0].result?.detail).toBe(SMALL_DETAIL);
    // 大的折叠了
    expect(out[1].toolCalls[1].result?.detail).toBe(FOLD_STUB);
  });

  it('折叠区含 context-compressed marker（无 toolCalls）时不抛错且原样跳过', () => {
    // 真实场景：readHistoryForLLM 返回的 history 首位可能是 context-compressed marker
    const marker: ChatMessage = {
      id: 'm0',
      conversationId: 'c',
      role: 'system',
      text: '已自动压缩早期 N 轮内容为摘要',
      toolCalls: [],
      createdAt: 0,
      done: true,
      kind: 'context-compressed',
    };
    const h: ChatMessage[] = [
      marker, // idx 0：在折叠区内，无 toolCalls 应被 toolCalls.length===0 分支跳过
      mkUser('u1'),
      mkAsst('a1', [mkTool({ id: 't1' })]), // 折叠区大 toolCall，应折叠
      mkUser('u2'),
      mkUser('u3'),
      mkUser('u4'),
    ];
    const out = applyTier1Folding(h);
    expect(out[0]).toBe(marker); // marker 原样
    expect(out[2].toolCalls[0].result?.detail).toBe(FOLD_STUB); // 后面的 toolCall 折叠
  });
});
