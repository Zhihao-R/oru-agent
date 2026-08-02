/**
 * 折叠水印（S16 G63）单元测试
 *
 * 折叠从「每轮重算的滑动窗」改为「持久水印」：
 * - computeFoldWatermark(history) 给出整理时刻水印应前移到的消息 id（当前折叠窗边界）
 * - applyFoldingByWatermark(history, id) 按固定水印折叠——水印之前的工具回执折成占位
 *
 * 关键性质：水印固定时，对话继续增长不会让折叠区跟着滑动（现状每轮必折、碎缓存的回归）。
 */
import { describe, expect, it } from 'vitest';
import {
  applyFoldingByWatermark,
  computeFoldWatermark,
} from '../../electron/main/agent/context/applyTier1Folding';
import type { ChatMessage, ToolCall } from '../../shared/types';

const FOLD_STUB = '[早期结果已折叠，需要原文请重新调用]';
const BIG_DETAIL = 'x'.repeat(2000);

function mkUser(id: string): ChatMessage {
  return { id, conversationId: 'c', role: 'user', text: 'hi', toolCalls: [], createdAt: 0, done: true };
}
function mkTool(id: string): ToolCall {
  return {
    id,
    name: 'read_file',
    input: {},
    status: 'completed',
    startedAt: 0,
    finishedAt: 1,
    result: { toolCallId: id, isError: false, summary: 's', detail: BIG_DETAIL },
  };
}
function mkAsst(id: string, tcId: string): ChatMessage {
  return { id, conversationId: 'c', role: 'assistant', text: '', toolCalls: [mkTool(tcId)], createdAt: 0, done: true };
}

// 5 user 轮的基准盘面
function base5(): ChatMessage[] {
  return [
    mkUser('u1'),
    mkAsst('a1', 't1'),
    mkUser('u2'),
    mkAsst('a2', 't2'),
    mkUser('u3'),
    mkAsst('a3', 't3'),
    mkUser('u4'),
    mkAsst('a4', 't4'),
    mkUser('u5'),
  ];
}

describe('computeFoldWatermark', () => {
  it('5 轮 user → 水印落在倒数第 3 个 user（u3），其前可折', () => {
    expect(computeFoldWatermark(base5())).toBe('u3');
  });

  it('≤3 轮 user → 无水印（undefined）', () => {
    const h = [mkUser('u1'), mkAsst('a1', 't1'), mkUser('u2'), mkUser('u3')];
    expect(computeFoldWatermark(h)).toBeUndefined();
  });
});

describe('applyFoldingByWatermark', () => {
  it('按水印 u3 折叠：u3 之前的工具回执成桩，u3 及之后原样', () => {
    const out = applyFoldingByWatermark(base5(), 'u3');
    expect(out[1].toolCalls[0].result?.detail).toBe(FOLD_STUB); // a1 折
    expect(out[3].toolCalls[0].result?.detail).toBe(FOLD_STUB); // a2 折
    expect(out[5].toolCalls[0].result?.detail).toBe(BIG_DETAIL); // a3 留
    expect(out[7].toolCalls[0].result?.detail).toBe(BIG_DETAIL); // a4 留
  });

  it('水印 undefined → 不折叠，引用原样返回', () => {
    const h = base5();
    expect(applyFoldingByWatermark(h, undefined)).toBe(h);
  });

  it('水印 id 不在视图中 → 视为无水印、不折', () => {
    const h = base5();
    expect(applyFoldingByWatermark(h, 'nonexistent')).toBe(h);
  });

  it('水印固定时对话继续增长，折叠区不滑动（不再每轮必折、前缀逐字节稳定）', () => {
    const h1 = base5();
    const folded1 = applyFoldingByWatermark(h1, 'u3');
    // 对话又长了两条，但水印仍是 u3（未到整理时刻不前移）
    const h2 = [...base5(), mkAsst('a5', 't5'), mkUser('u6')];
    const folded2 = applyFoldingByWatermark(h2, 'u3');
    // 折叠前缀（u3 之前）在两次之间逐字节一致——prompt cache 稳定的代理断言
    expect(folded2.slice(0, 5)).toEqual(folded1.slice(0, 5));
    // 且新长出的 a5 未被折（水印没动，折叠区没扩到它）
    expect(folded2[9].toolCalls[0].result?.detail).toBe(BIG_DETAIL);
  });
});
