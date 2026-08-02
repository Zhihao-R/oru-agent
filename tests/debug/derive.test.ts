/**
 * StreamDeriver FSM —— LLM 调用边界推导
 *
 * 重点回归：claude-code 后端不发 llm_usage 时，一轮里中间每次带工具的 LLM 调用
 * 也必须 emit llm_call_done。否则前端把它们误标「未完成」（见 2026-06-10 调查）。
 */
import { describe, it, expect } from 'vitest';
import { StreamDeriver, type DeriverMeta } from '../../electron/main/debug/derive';
import type { DebugRecord } from '@shared/debug/types';
import type { ConversationEvent } from '@shared/agent/backend';

const META: DeriverMeta = {
  roundId: 'r1',
  conversationId: 'c1',
  ownerId: 'o1',
  agentId: 'a1',
  agentName: 'A',
  backendType: 'claude-code',
  modelId: 'claude-x',
};

/** 喂一串事件，收集所有 emit 出来的 record */
function run(events: ConversationEvent[]): DebugRecord[] {
  const out: DebugRecord[] = [];
  const d = new StreamDeriver(META, (r) => out.push(r), Date.now(), 0);
  for (const ev of events) d.feed(ev);
  return out;
}

const doneIndices = (recs: DebugRecord[]) =>
  recs
    .filter((r) => r.type === 'llm_call_done')
    .map((r) => (r.payload as { callIndex: number }).callIndex);

describe('StreamDeriver — claude-code 形态（无 llm_usage）', () => {
  it('中间每次带工具的 LLM 调用都 emit llm_call_done', () => {
    const recs = run([
      { type: 'assistant_text', text: '想一下' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'tool_result', toolUseId: 't1', isError: false, content: 'ok' },
      { type: 'assistant_text', text: '再改' },
      { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
      { type: 'tool_result', toolUseId: 't2', isError: false, content: 'ok' },
      { type: 'result', resultText: '完成', isError: false },
    ]);
    // 调用 #1（Read）、#2（Edit）、#3（最终文本）全部应有 done
    expect(doneIndices(recs)).toEqual([1, 2, 3]);
  });

  it('每个 llm_call_start 都有配对的 llm_call_done（无悬空 = 无「未完成」）', () => {
    const recs = run([
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'tool_result', toolUseId: 't1', isError: false, content: 'ok' },
      { type: 'tool_use', id: 't2', name: 'Edit', input: {} },
      { type: 'tool_result', toolUseId: 't2', isError: false, content: 'ok' },
      { type: 'result', resultText: '完成', isError: false },
    ]);
    const starts = recs.filter((r) => r.type === 'llm_call_start').length;
    const dones = recs.filter((r) => r.type === 'llm_call_done').length;
    expect(dones).toBe(starts);
  });
});

describe('StreamDeriver — anthropic 形态（有 llm_usage）', () => {
  it('llm_usage 终结调用并填 token；兜底不造成重复 done', () => {
    const recs = run([
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'llm_usage', inputTokens: 100, outputTokens: 50 },
      { type: 'tool_result', toolUseId: 't1', isError: false, content: 'ok' },
      { type: 'llm_usage', inputTokens: 200, outputTokens: 80 },
      { type: 'result', resultText: '完成', isError: false },
    ]);
    // #1 由 llm_usage 终结、带 token；#2 最终调用由末尾 llm_usage 终结
    expect(doneIndices(recs)).toEqual([1, 2]);
    const done1 = recs.find(
      (r) => r.type === 'llm_call_done' && (r.payload as { callIndex: number }).callIndex === 1,
    );
    expect((done1!.payload as { inputTokens?: number }).inputTokens).toBe(100);
  });
});

describe('StreamDeriver — seq 跨 retry 续接', () => {
  it('getSeq 返回内部当前 seq；按 RoundLogger 续接逻辑构造的第二个 deriver 首条 seq 严格大于第一个末条', () => {
    const out1: DebugRecord[] = [];
    const d1 = new StreamDeriver(META, (r) => out1.push(r), Date.now(), 0);
    d1.feed({ type: 'tool_use', id: 't1', name: 'Read', input: {} });
    d1.feed({ type: 'tool_result', toolUseId: 't1', isError: false, content: 'ok' });
    const lastSeq1 = out1[out1.length - 1].seq;
    expect(d1.getSeq()).toBe(lastSeq1);

    // 模拟 RoundLogger.makeStreamDeriver 的 retry 续接：startSeq 取 max(logger 自身 seq, deriver seq)
    const loggerOwnSeq = 1; // logger 自己 emit 过 prompt_built 等少量 record，落后于 deriver
    const out2: DebugRecord[] = [];
    const d2 = new StreamDeriver(
      META,
      (r) => out2.push(r),
      Date.now(),
      Math.max(loggerOwnSeq, d1.getSeq()),
    );
    expect(out2[0].seq).toBeGreaterThan(lastSeq1);
  });
});

describe('StreamDeriver — finishRound', () => {
  it('round_done 计数与时长字段如实（llmCallCount / toolCallCount / totalDurationMs / hadError）', () => {
    const out: DebugRecord[] = [];
    const d = new StreamDeriver(META, (r) => out.push(r), Date.now(), 0);
    for (const ev of [
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'tool_result', toolUseId: 't1', isError: false, content: 'ok' },
      { type: 'result', resultText: '完成', isError: false },
    ] as ConversationEvent[]) {
      d.feed(ev);
    }
    d.finishRound(false);

    const dones = out.filter((r) => r.type === 'round_done');
    expect(dones).toHaveLength(1);
    const payload = dones[0].payload as {
      llmCallCount: number;
      toolCallCount: number;
      totalDurationMs: number;
      hadError: boolean;
    };
    expect(payload.llmCallCount).toBe(2); // #1 带工具 + #2 最终文本
    expect(payload.toolCallCount).toBe(1);
    expect(payload.hadError).toBe(false);
    expect(payload.totalDurationMs).toBeGreaterThanOrEqual(0);
    // round_done 是本 deriver 最后一条 record
    expect(out[out.length - 1].type).toBe('round_done');
  });
});
