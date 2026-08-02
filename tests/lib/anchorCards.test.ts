/**
 * S1 回合内锚点 detachAnchoredCards 的单元测试。
 *
 * 验证目标问题本身（位置断言）：带 anchorTo 的保留卡（memory-record / skill-call / plugin-activate）
 * 被从顶层流抽出、映射到对应 assistant 消息；同回合多张卡保持相对顺序；匹配不到锚定消息时优雅降级
 * 留顶层 + 触发降级计数；老卡无 anchorTo 行为不变；非锚定 kind 不误抽。
 */
import { describe, expect, it } from 'vitest';
import { ANCHORED_CARD_KINDS, anchorCardMissCount, detachAnchoredCards } from '@/lib/anchorCards';
import type { ChatMessage } from '@shared/types';

function assistantMsg(id: string): ChatMessage {
  return {
    id,
    conversationId: 'c',
    role: 'assistant',
    text: `回复 ${id}`,
    toolCalls: [],
    createdAt: 1,
    done: true,
  };
}

function anchoredCard(
  id: string,
  kind: 'memory-record' | 'skill-call' | 'plugin-activate',
  anchorMsgId: string,
  overrides: Partial<ChatMessage> = {},
): ChatMessage {
  const base: ChatMessage = {
    id,
    conversationId: 'c',
    role: 'system',
    text: '',
    toolCalls: [],
    createdAt: 2,
    done: true,
    kind,
    anchorTo: { messageId: anchorMsgId },
  };
  // skill-call / plugin-activate 需要 skillModuleAction 才能走 SkillModuleChip 渲染；测试只关心抽出逻辑
  return { ...base, ...overrides };
}

const item = (m: ChatMessage) => ({ kind: 'message' as const, key: m.id, ts: 1, data: m });
const proposalItem = { kind: 'proposalGroup' as const, key: 'pg1', ts: 1, data: [] };

function resetCount() {
  anchorCardMissCount.value = 0;
}

describe('detachAnchoredCards', () => {
  it('带 anchorTo 的卡被抽出并映射到对应 assistant 消息', () => {
    const { topItems, anchoredByMsg } = detachAnchoredCards([
      item(assistantMsg('m1')),
      item(anchoredCard('mem1', 'memory-record', 'm1')),
      item(assistantMsg('m2')),
    ]);
    // 顶层只剩两条 assistant 回复，卡被抽走
    expect(topItems).toHaveLength(2);
    expect(topItems.map((i) => (i.kind === 'message' ? i.data.id : ''))).toEqual(['m1', 'm2']);
    // 卡映射到 m1 之后
    expect(anchoredByMsg.get('m1')?.map((c) => c.id)).toEqual(['mem1']);
  });

  it('同回合多张卡保持相对数组序', () => {
    const { anchoredByMsg } = detachAnchoredCards([
      item(assistantMsg('m1')),
      item(anchoredCard('a', 'memory-record', 'm1')),
      item(anchoredCard('b', 'skill-call', 'm1')),
      item(anchoredCard('c', 'plugin-activate', 'm1')),
    ]);
    expect(anchoredByMsg.get('m1')?.map((c) => c.id)).toEqual(['a', 'b', 'c']);
  });

  it('匹配不到锚定消息 → 卡留顶层（降级不丢卡）且触发降级计数', () => {
    resetCount();
    const { topItems, anchoredByMsg } = detachAnchoredCards([
      // 卡锚定的 m1 不存在（崩溃/被撤/重载未落盘）
      item(anchoredCard('orphan', 'memory-record', 'missing')),
    ]);
    expect(topItems).toHaveLength(1);
    expect(topItems[0].kind === 'message' && topItems[0].data.id).toBe('orphan');
    expect(anchoredByMsg.size).toBe(0);
    expect(anchorCardMissCount.value).toBe(1);
  });

  it('无 anchorTo 的老卡完全留顶层，行为不变', () => {
    resetCount();
    const old = { ...anchoredCard('old1', 'memory-record', 'unused'), anchorTo: undefined };
    delete old.anchorTo;
    const { topItems, anchoredByMsg } = detachAnchoredCards([item(assistantMsg('m1')), item(old)]);
    expect(topItems).toHaveLength(2);
    expect(anchoredByMsg.size).toBe(0);
    expect(anchorCardMissCount.value).toBe(0);
  });

  it('非锚定 kind 但带 anchorTo 的卡不误抽（防御）', () => {
    const weird = {
      ...anchoredCard('weird1', 'memory-record', 'm1'),
      kind: 'context-compressed' as const,
    };
    weird.kind = 'context-compressed';
    const w: ChatMessage = { ...weird };
    const { topItems, anchoredByMsg } = detachAnchoredCards([item(assistantMsg('m1')), item(w)]);
    // context-compressed 不在锚定集合 → 留在顶层
    expect(topItems).toHaveLength(2);
    expect(topItems.map((i) => (i.kind === 'message' ? i.data.id : ''))).toEqual(['m1', 'weird1']);
    expect(anchoredByMsg.size).toBe(0);
  });

  it('非 message 项（proposal 组）透传、位置不变', () => {
    const { topItems } = detachAnchoredCards([
      item(assistantMsg('m1')),
      proposalItem,
      item(assistantMsg('m2')),
    ]);
    expect(topItems.map((i) => i.kind)).toEqual(['message', 'proposalGroup', 'message']);
  });

  it('ANCHORED_CARD_KINDS 覆盖三类保留卡', () => {
    expect(ANCHORED_CARD_KINDS.has('memory-record')).toBe(true);
    expect(ANCHORED_CARD_KINDS.has('skill-call')).toBe(true);
    expect(ANCHORED_CARD_KINDS.has('plugin-activate')).toBe(true);
    expect(ANCHORED_CARD_KINDS.has('context-compressed')).toBe(false);
    expect(ANCHORED_CARD_KINDS.has('plugin-install')).toBe(false);
  });
});
