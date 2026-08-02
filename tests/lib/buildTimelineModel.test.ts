/**
 * buildTimelineModel 关键不变量：合并节点的 relMs 取 start.relMs
 *
 * 防回归：跟并发组的 startRecord.relMs 在同一时间维度上对齐——避免
 * "工具看起来比组晚" 的视觉错觉（PRD §2.2）。
 */
import { describe, it, expect } from 'vitest';
import type { DebugRecord } from '@shared/debug/types';
import { buildTimelineModel } from '@/lib/buildTimelineModel';

function rec<T extends DebugRecord['type']>(
  type: T,
  relMs: number,
  payload: Record<string, unknown>,
  seq: number,
): DebugRecord {
  return {
    ts: 1_700_000_000_000 + relMs,
    relMs,
    roundId: 'r1',
    conversationId: 'c1',
    ownerId: 'o',
    agentId: 'a',
    agentName: 'A',
    type,
    seq,
    payload: payload as never,
  } as DebugRecord;
}

describe('buildTimelineModel — 合并节点 relMs 取 start.relMs', () => {
  it('llm_call 节点 relMs 来自 llm_call_start，不是 done', () => {
    const records: DebugRecord[] = [
      rec('round_start', 0, { source: 'main_chat', userText: 'hi' }, 0),
      rec('llm_call_start', 100, { callIndex: 1, backendType: 'anthropic' }, 1),
      rec('llm_call_done', 9_100, { callIndex: 1, durationMs: 9000, outputText: '' }, 2),
    ];
    const m = buildTimelineModel(records);
    const llm = m.nodes.find((n) => n.kind === 'event' && n.displayType === 'llm_call');
    expect(llm).toBeDefined();
    if (llm?.kind === 'event') {
      expect(llm.relMs).toBe(100); // start time, not done time (9100)
    }
  });

  it('tool_call 节点 relMs 跟所属并发组的 start 对齐', () => {
    const records: DebugRecord[] = [
      rec('round_start', 0, { source: 'main_chat', userText: 'hi' }, 0),
      rec('llm_call_start', 100, { callIndex: 1, backendType: 'anthropic' }, 1),
      rec('parallel_group_start', 9_050, { groupId: 'g1', llmCallIndex: 1 }, 2),
      rec('tool_call_start', 9_055, { toolCallId: 't1', name: 'web_search', input: {} }, 3),
      rec('tool_call_done', 9_408, { toolCallId: 't1', durationMs: 353, isError: false, output: null }, 4),
      rec('parallel_group_done', 9_410, { groupId: 'g1', llmCallIndex: 1, longestDurationMs: 353 }, 5),
    ];
    const m = buildTimelineModel(records);
    const group = m.nodes.find((n) => n.kind === 'group');
    expect(group?.kind).toBe('group');
    if (group?.kind === 'group') {
      // 工具节点 relMs = tool_call_start.relMs = 9055，跟 group start 9050 同一维度（都是开始时刻）
      expect(group.startRecord.relMs).toBe(9_050);
      expect(group.children).toHaveLength(1);
      expect(group.children[0].relMs).toBe(9_055);
      // 反测：done.relMs 9408 不应该出现在节点 relMs 上
      expect(group.children[0].relMs).not.toBe(9_408);
    }
  });

  it('llm_call_done 永远在顶层——即便 ndjson 物理位置落在 parallel_group 内部', () => {
    // 模拟新协议：tool_use 在 llm_usage 前到，所以 ndjson 序列里
    // parallel_group_start / tool_call_start 在 llm_call_done 之前。
    // 前端必须把 llm_call_done 重排到顶层，不能吞进 group.children。
    const records: DebugRecord[] = [
      rec('round_start', 0, { source: 'main_chat', userText: 'hi' }, 0),
      rec('llm_call_start', 100, { callIndex: 1, backendType: 'anthropic' }, 1),
      rec('parallel_group_start', 9_050, { groupId: 'g1', llmCallIndex: 1 }, 2),
      rec('tool_call_start', 9_055, { toolCallId: 't1', name: 'web_search', input: {} }, 3),
      // ↓ llm_call_done 物理上排在 group 内部（llm_usage 在 tool_use 之后到）
      rec('llm_call_done', 9_055, {
        callIndex: 1,
        durationMs: 8_955,
        outputText: '',
        inputTokens: 5000,
      }, 4),
      rec('tool_call_done', 9_408, { toolCallId: 't1', durationMs: 353, isError: false, output: null }, 5),
      rec('parallel_group_done', 9_410, { groupId: 'g1', llmCallIndex: 1, longestDurationMs: 353 }, 6),
    ];
    const m = buildTimelineModel(records);
    // 顶层节点应有：round_start, llm_call, group（按出现顺序）
    expect(m.nodes.map((n) => (n.kind === 'group' ? 'group' : n.displayType))).toEqual([
      'round_start',
      'group',
      'llm_call', // ← 不在 group.children 里
    ]);
    const llm = m.nodes.find((n) => n.kind === 'event' && n.displayType === 'llm_call');
    expect(llm?.kind).toBe('event');
    if (llm?.kind === 'event') {
      expect((llm.record.payload as { inputTokens?: number }).inputTokens).toBe(5000);
    }
    const group = m.nodes.find((n) => n.kind === 'group');
    expect(group?.kind).toBe('group');
    if (group?.kind === 'group') {
      // group 只有 1 个 tool 子项，不含 llm_call
      expect(group.children).toHaveLength(1);
      expect(group.children[0].displayType).toBe('tool_call');
    }
  });

  it('未完成节点（无 done）relMs 用 start 自身', () => {
    const records: DebugRecord[] = [
      rec('round_start', 0, { source: 'main_chat', userText: 'hi' }, 0),
      rec('llm_call_start', 200, { callIndex: 1, backendType: 'anthropic' }, 1),
      // 没有 llm_call_done — 模拟 kill -9
    ];
    const m = buildTimelineModel(records);
    const unfin = m.nodes.find(
      (n) => n.kind === 'event' && n.displayType === 'llm_call' && n.unfinished,
    );
    expect(unfin).toBeDefined();
    if (unfin?.kind === 'event') {
      expect(unfin.relMs).toBe(200);
    }
  });
});
