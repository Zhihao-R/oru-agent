/**
 * runRoundTrip 续发检查点钩子编排（S16 G66）
 *
 * 循环尾（appendToolResults 之后、下一轮 streamOnce 之前）调 onBeforeContinuation：
 * - 首个请求不经此钩子（continuationIndex 从 1 起）
 * - 返回 history → adapter.replaceSeedHistory(history) 后照常进下一轮
 * - 返回 null → 不替换 seed、行为零变化
 * - 未挂钩子 → 行为与现状完全一致
 */
import { describe, it, expect } from 'vitest';
import type { ConversationInput, ConversationEvent } from '@shared/agent/backend';
import type { ChatMessage } from '@shared/types';
import {
  runRoundTrip,
  type ProtocolAdapter,
  type RoundResult,
  type ToolExecResult,
} from '../../electron/main/agent/backends/roundTrip';

function mkInput(overrides: Partial<ConversationInput>): ConversationInput {
  return {
    agentId: 'a',
    conversationId: 'c',
    userMessage: 'hi',
    history: [],
    cwd: process.cwd(),
    abortController: new AbortController(),
    toolContext: {
      conversationId: 'c',
      agentId: 'a',
      ownerId: 'o',
      approvalMode: 'work',
      usage: 'twinMain',
      abortSignal: new AbortController().signal,
    },
    ...overrides,
  };
}

/** mock adapter：前 toolRounds 轮返回工具调用，之后返回 final。记录 replaceSeedHistory 入参。 */
function mkAdapter(toolRounds: number): {
  adapter: ProtocolAdapter;
  replaced: ChatMessage[][];
  appendCount: () => number;
} {
  let round = 0;
  let appends = 0;
  const replaced: ChatMessage[][] = [];
  const adapter: ProtocolAdapter = {
    async *streamOnce(): AsyncGenerator<ConversationEvent, RoundResult> {
      round += 1;
      if (round <= toolRounds) {
        return { toolCalls: [{ id: `t${round}`, name: 'read', input: {} }], isToolCall: true, finalText: '' };
      }
      return { toolCalls: [], isToolCall: false, finalText: 'done' };
    },
    appendToolResults() {
      appends += 1;
    },
    buildResultUsage() {
      return undefined;
    },
    async replaceSeedHistory(history: ChatMessage[]) {
      replaced.push(history);
    },
  };
  return { adapter, replaced, appendCount: () => appends };
}

const exec = async (): Promise<ToolExecResult> => ({ text: 'ok', isError: false });

async function drain(gen: AsyncGenerator<ConversationEvent>): Promise<void> {
  for await (const _ of gen) void _;
}

describe('runRoundTrip · onBeforeContinuation（续发检查点）', () => {
  it('续发前调钩子，首个请求不调；continuationIndex 从 1、reason=checkpoint', async () => {
    const { adapter } = mkAdapter(2); // 2 轮工具 → 2 次续发
    const calls: Array<{ continuationIndex: number; reason: string }> = [];
    await drain(
      runRoundTrip(
        adapter,
        mkInput({
          onBeforeContinuation: async (info) => {
            calls.push(info);
            return null;
          },
        }),
        exec,
        new Set(['read']),
      ),
    );
    expect(calls).toEqual([
      { continuationIndex: 1, reason: 'checkpoint' },
      { continuationIndex: 2, reason: 'checkpoint' },
    ]);
  });

  it('钩子返回 history → adapter.replaceSeedHistory 被调用该 history', async () => {
    const { adapter, replaced } = mkAdapter(1); // 1 次续发
    const organized: ChatMessage[] = [
      { id: 'm', conversationId: 'c', role: 'system', text: '摘要', toolCalls: [], createdAt: 0, done: true },
    ];
    await drain(
      runRoundTrip(
        adapter,
        mkInput({ onBeforeContinuation: async () => organized }),
        exec,
        new Set(['read']),
      ),
    );
    expect(replaced).toEqual([organized]);
  });

  it('钩子返回 null → 不调 replaceSeedHistory', async () => {
    const { adapter, replaced } = mkAdapter(1);
    await drain(
      runRoundTrip(adapter, mkInput({ onBeforeContinuation: async () => null }), exec, new Set(['read'])),
    );
    expect(replaced).toEqual([]);
  });

  it('未挂钩子 → 不调 replaceSeedHistory、循环正常收敛', async () => {
    const { adapter, replaced, appendCount } = mkAdapter(1);
    await drain(runRoundTrip(adapter, mkInput({}), exec, new Set(['read'])));
    expect(replaced).toEqual([]);
    expect(appendCount()).toBe(1); // 1 轮工具 → 1 次 appendToolResults
  });

  it('续发轮 streamOnce 抛 overflow（流开始前）→ reason=overflow 整理、replaceSeedHistory 后重发一次成功', async () => {
    // 第 1 轮工具调用；第 2 轮（续发）首次 streamOnce 抛 overflow、重发后返回 final。
    let round = 0;
    let overflowThrown = false;
    const replaced: ChatMessage[][] = [];
    const adapter: ProtocolAdapter = {
      async *streamOnce(): AsyncGenerator<ConversationEvent, RoundResult> {
        round += 1;
        if (round === 1) {
          return { toolCalls: [{ id: 't1', name: 'read', input: {} }], isToolCall: true, finalText: '' };
        }
        // 第 2 轮：首次抛 overflow（流开始前，未 yield）；replaceSeedHistory 后的重发放行
        if (!overflowThrown) {
          overflowThrown = true;
          throw new Error('context window exceeded');
        }
        return { toolCalls: [], isToolCall: false, finalText: 'done' };
      },
      appendToolResults() {},
      buildResultUsage() {
        return undefined;
      },
      async replaceSeedHistory(h: ChatMessage[]) {
        replaced.push(h);
      },
    };
    const reasons: string[] = [];
    const organized: ChatMessage[] = [
      { id: 'm', conversationId: 'c', role: 'system', text: '摘要', toolCalls: [], createdAt: 0, done: true },
    ];
    await drain(
      runRoundTrip(
        adapter,
        mkInput({
          onBeforeContinuation: async ({ reason }) => {
            reasons.push(reason);
            return organized;
          },
        }),
        exec,
        new Set(['read']),
      ),
    );
    // checkpoint 先调（续发前），overflow 再调（重发前）
    expect(reasons).toEqual(['checkpoint', 'overflow']);
    // 两次都替换了 seed（checkpoint 一次 + overflow 一次）
    expect(replaced).toEqual([organized, organized]);
  });
});
