/**
 * 折叠相邻终态 subagent 完成行（2026-07-30 拍板）——相邻 ≥2 条收成「N 个 subagent」，
 * 与工具折叠同款相邻分组、但自成一类计数（工具是主 agent 的动作，subagent 是派出去的孩子，不混计）。
 */
import { describe, expect, it } from 'vitest';
import { foldSubagentGroups } from '@/lib/foldSubagentGroups';
import type { FoldedItem } from '@/lib/foldBashProposalGroups';
import type { ChatMessage, SubagentChipRef } from '@shared/types';

function subagentMsg(id: string, status: SubagentChipRef['status'] = 'completed'): ChatMessage {
  return {
    id,
    conversationId: 'c',
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: 1,
    done: true,
    kind: 'subagent',
    subagent: { taskId: `sub_${id}`, description: id, prompt: 'p', startedAt: 1, status },
  };
}

function plainMsg(id: string): ChatMessage {
  // 普通文本消息 kind 缺省（ChatMessageKind 联合里没有 'text'）
  return {
    id,
    conversationId: 'c',
    role: 'assistant',
    text: id,
    toolCalls: [],
    createdAt: 1,
    done: true,
  };
}

const item = (m: ChatMessage): FoldedItem<ChatMessage> => ({
  kind: 'message',
  key: m.id,
  ts: 1,
  data: m,
});

describe('foldSubagentGroups', () => {
  it('相邻多条终态 subagent 折成一组（目标形态：不再多张卡片并排）', () => {
    const out = foldSubagentGroups([item(subagentMsg('a')), item(subagentMsg('b')), item(subagentMsg('c', 'error'))]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe('subagentGroup');
    if (out[0].kind === 'subagentGroup') {
      expect(out[0].data.map((m) => m.id)).toEqual(['a', 'b', 'c']);
      expect(out[0].ts).toBe(1);
    }
  });

  it('孤立单条终态 → 组里只 1 条（渲染层据此退化单行）', () => {
    const out = foldSubagentGroups([item(plainMsg('m')), item(subagentMsg('a'))]);
    expect(out[1].kind).toBe('subagentGroup');
    if (out[1].kind === 'subagentGroup') expect(out[1].data).toHaveLength(1);
  });

  it('中间插一条普通消息 → 断成两组', () => {
    const out = foldSubagentGroups([item(subagentMsg('a')), item(plainMsg('m1')), item(subagentMsg('b'))]);
    expect(out.map((i) => i.kind)).toEqual(['subagentGroup', 'message', 'subagentGroup']);
  });

  it('运行中 / 等审批的 subagent 不折，且断开相邻组', () => {
    const out = foldSubagentGroups([
      item(subagentMsg('a')),
      item(subagentMsg('r', 'running')),
      item(subagentMsg('b')),
      item(subagentMsg('w', 'awaiting_approval')),
      item(subagentMsg('c')),
    ]);
    expect(out.map((i) => i.kind)).toEqual([
      'subagentGroup',
      'message',
      'subagentGroup',
      'message',
      'subagentGroup',
    ]);
  });

  it('中间插提案类时间线项 → 断开', () => {
    // 提案组项对折叠而言是不透明的透传项（折叠不读 data），空数组即可代表
    const proposalGroup: FoldedItem<ChatMessage> = { kind: 'proposalGroup', key: 'g1', ts: 1, data: [] };
    const out = foldSubagentGroups([item(subagentMsg('a')), proposalGroup, item(subagentMsg('b'))]);
    expect(out.map((i) => i.kind)).toEqual(['subagentGroup', 'proposalGroup', 'subagentGroup']);
  });

  it('非 subagent 消息原样通过，不进组', () => {
    const out = foldSubagentGroups([item(plainMsg('m1')), item(plainMsg('m2'))]);
    expect(out.map((i) => i.kind)).toEqual(['message', 'message']);
  });
});
