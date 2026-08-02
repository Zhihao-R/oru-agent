/**
 * 连续中断的历史折叠（呼应 interrupted-turn-recovery PRD 验收项）
 *
 * 场景：用户被打断后点「继续」续跑（chat.resume 不落新 user 消息），又被打断——
 * 历史里出现两条相邻的 incomplete assistant。验证 adaptHistory：
 *  - 两条半截都被折叠成 assistant text（悬空 tool_use 标"未完成"）
 *  - 相邻两条 assistant 不丢、不串台（Anthropic 侧会合并同 role，不会 400）
 *  - 中间夹着的用户消息不丢
 *
 * 不打 Claude。
 */
import { describe, expect, it } from 'vitest';
import { adaptHistory } from '../../electron/main/agent/backends/historyAdapter';
import { buildInterruptedMessage, type InterruptedTurn } from '../../electron/main/agent/interrupted';
import type { ChatMessage, ToolCall } from '../../shared/types';

const meta = {
  backendType: 'anthropic' as const,
  toolProtocol: 'anthropic-native' as const,
  modelId: 'm',
  providerId: 'p',
};

function makeUser(id: string, text: string): ChatMessage {
  return { id, conversationId: 'c1', role: 'user', text, toolCalls: [], createdAt: 1, done: true };
}

/** 造一条「写文件写到一半被打断」的 incomplete assistant（带文字 + 悬空 tool_use）。 */
function makeInterrupted(id: string, text: string): ChatMessage {
  const toolCalls: ToolCall[] = [
    { id: `${id}_tc`, name: 'write_file', input: { path: '/x' }, status: 'running', startedAt: 1 },
  ];
  const turn: InterruptedTurn = { partial: { resultText: text, toolCalls }, reason: 'upstream_error', meta };
  const msg = buildInterruptedMessage(turn, { id, conversationId: 'c1' }, 1);
  if (!msg) throw new Error('fixture: buildInterruptedMessage 不应返回 null');
  return msg;
}

describe('G29：同协议下为悬空 tool_use 合成「被中止」回执（不再整条折叠）', () => {
  it('anthropic-native 同协议：悬空 tool_use 保结构 + 配一条合成 tool_result（isError），每个 tool_use 都成对不 400', () => {
    const history: ChatMessage[] = [makeInterrupted('a1', '写到一半')];
    const { messages } = adaptHistory({ messages: history, targetProtocol: 'anthropic-native' });

    const assistant = messages.find((m) => m.role === 'assistant');
    expect(assistant).toBeDefined();
    const toolUses = assistant!.blocks.filter((b) => b.type === 'tool_use');
    expect(toolUses).toHaveLength(1); // 悬空 tool_use 结构保留，不再被折叠成纯文字

    const user = messages.find((m) => m.role === 'user');
    expect(user).toBeDefined();
    const results = user!.blocks.filter((b) => b.type === 'tool_result');
    expect(results).toHaveLength(1); // 合成一条回执与悬空 tool_use 配对
    const tr = results[0];
    if (tr.type !== 'tool_result') throw new Error('unreachable');
    expect(tr.isError).toBe(true); // 中止未成功
    expect(tr.content).toContain('中止');
    expect(tr.toolUseId).toBe('a1_tc'); // 回执挂在正确的 tool_use 上

    // 合法性硬约束：每个 tool_use 都有配对的 tool_result（否则 Anthropic 400）
    const allToolUseIds = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_use').map((b) => (b.type === 'tool_use' ? b.id : '')));
    const allResultIds = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_result').map((b) => (b.type === 'tool_result' ? b.toolUseId : '')));
    for (const id of allToolUseIds) expect(allResultIds).toContain(id);
  });

  it('混合：同条消息里已完成工具保原始 result、悬空工具配合成回执（不因一个悬空拖垮全部结构）', () => {
    const toolCalls: ToolCall[] = [
      {
        id: 'done_tc',
        name: 'read_file',
        input: { path: '/a' },
        status: 'success',
        startedAt: 1,
        finishedAt: 2,
        result: { toolCallId: 'done_tc', isError: false, summary: '读到了', detail: '文件内容 ABC' },
      },
      { id: 'orphan_tc', name: 'write_file', input: { path: '/b' }, status: 'running', startedAt: 3 },
    ];
    const turn: InterruptedTurn = { partial: { resultText: '先读再写', toolCalls }, reason: 'aborted', meta };
    const msg = buildInterruptedMessage(turn, { id: 'mix', conversationId: 'c1' }, 1)!;
    const { messages } = adaptHistory({ messages: [msg], targetProtocol: 'anthropic-native' });

    const user = messages.find((m) => m.role === 'user')!;
    const byId = new Map(user.blocks.filter((b) => b.type === 'tool_result').map((b) => (b.type === 'tool_result' ? [b.toolUseId, b] : ['', b])));
    const done = byId.get('done_tc');
    const orphan = byId.get('orphan_tc');
    if (done?.type !== 'tool_result' || orphan?.type !== 'tool_result') throw new Error('缺回执');
    expect(done.content).toContain('文件内容 ABC'); // 已完成工具用原始 result
    expect(done.isError).toBe(false);
    expect(orphan.content).toContain('中止'); // 悬空工具用合成回执
    expect(orphan.isError).toBe(true);
  });
});

describe('adaptHistory：连续中断', () => {
  it('两条相邻半截（续跑不夹 user）都折叠为 assistant text，各自标"未完成"，不丢不串台', () => {
    const history: ChatMessage[] = [
      makeUser('u1', '帮我写个页面'),
      makeInterrupted('a1', '第一次写到一半'),
      makeInterrupted('a2', '续跑又写到一半'),
    ];
    const { messages } = adaptHistory({ messages: history, targetProtocol: 'anthropic-native' });

    // G29 后：每条半截 = assistant(text+tool_use) + user(合成 tool_result)，不再折叠成纯 text。
    // 两条半截各自成对，相邻不串台、不丢，且每个 tool_use 都配回执（合法，不 400）。
    const assistantTexts = messages
      .filter((m) => m.role === 'assistant')
      .map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''));
    expect(assistantTexts).toEqual(['第一次写到一半', '续跑又写到一半']); // 各保留自己文字、不互相覆盖

    const allToolUseIds = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_use').map((b) => (b.type === 'tool_use' ? b.id : '')));
    const allResultIds = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_result').map((b) => (b.type === 'tool_result' ? b.toolUseId : '')));
    expect(allToolUseIds).toEqual(['a1_tc', 'a2_tc']);
    for (const id of allToolUseIds) expect(allResultIds).toContain(id); // 每个 tool_use 都成对
    // 合成回执都标「被中止」
    const receipts = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_result').map((b) => (b.type === 'tool_result' ? b.content : '')));
    expect(receipts.every((c) => c.includes('中止'))).toBe(true);
    // 首条用户消息不丢
    expect(messages[0].blocks.map((b) => (b.type === 'text' ? b.text : '')).join('')).toContain('帮我写个页面');
  });

  it('两次中断之间夹着的用户消息不丢', () => {
    const history: ChatMessage[] = [
      makeUser('u1', '第一个问题'),
      makeInterrupted('a1', '答到一半被打断'),
      makeUser('u2', '中间追加的问题'),
      makeInterrupted('a2', '又答到一半被打断'),
    ];
    const { messages } = adaptHistory({ messages: history, targetProtocol: 'anthropic-native' });

    const joined = messages
      .map((m) => m.blocks.map((b) => (b.type === 'text' ? b.text : '')).join(''))
      .join('|');
    expect(joined).toContain('中间追加的问题'); // 夹在两条半截之间的 user 不丢
    // 两条半截的文字都在、都合法配对（各自 assistant+合成回执）
    expect(joined).toContain('答到一半被打断');
    expect(joined).toContain('又答到一半被打断');
    const allToolUseIds = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_use').map((b) => (b.type === 'tool_use' ? b.id : '')));
    const allResultIds = messages.flatMap((m) => m.blocks.filter((b) => b.type === 'tool_result').map((b) => (b.type === 'tool_result' ? b.toolUseId : '')));
    for (const id of allToolUseIds) expect(allResultIds).toContain(id);
  });
});
