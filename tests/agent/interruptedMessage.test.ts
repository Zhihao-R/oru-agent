import { describe, expect, it } from 'vitest';
import {
  attachInterruptedTurn,
  readInterruptedTurn,
  buildInterruptedMessage,
  type InterruptedTurn,
} from '../../electron/main/agent/interrupted';
import type { ToolCall } from '../../shared/types';

const meta = {
  backendType: 'anthropic' as const,
  toolProtocol: 'anthropic-native' as const,
  modelId: 'm',
  providerId: 'p',
};

describe('buildInterruptedMessage', () => {
  it('有文字时构造 incomplete assistant 消息，带 interrupted reason + 协议字段', () => {
    const turn: InterruptedTurn = {
      partial: { resultText: '我写到一半', toolCalls: [] },
      reason: 'upstream_error',
      meta,
    };
    const msg = buildInterruptedMessage(turn, { id: 'm1', conversationId: 'c1' }, 1000);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('assistant');
    expect(msg!.text).toBe('我写到一半');
    expect(msg!.interrupted).toBe('upstream_error');
    expect(msg!.done).toBe(true);
    expect(msg!.backendType).toBe('anthropic');
    expect(msg!.toolProtocol).toBe('anthropic-native');
    expect(msg!.createdAt).toBe(1000);
  });

  it('只有悬空工具调用（无文字）也落盘，悬空调用保持无 result', () => {
    const toolCalls: ToolCall[] = [
      { id: 't1', name: 'write_file', input: { path: '/x' }, status: 'running', startedAt: 1 },
    ];
    const turn: InterruptedTurn = { partial: { resultText: '', toolCalls }, reason: 'aborted', meta };
    const msg = buildInterruptedMessage(turn, { id: 'm1', conversationId: 'c1' }, 1000);
    expect(msg).not.toBeNull();
    expect(msg!.toolCalls).toHaveLength(1);
    expect(msg!.toolCalls[0].result).toBeUndefined();
    expect(msg!.interrupted).toBe('aborted');
  });

  it('partial 全空（一个 token 都没产出）→ 返回 null，不落盘', () => {
    const turn: InterruptedTurn = {
      partial: { resultText: '', toolCalls: [] },
      reason: 'upstream_error',
      meta,
    };
    expect(buildInterruptedMessage(turn, { id: 'm1', conversationId: 'c1' }, 1000)).toBeNull();
  });
});

describe('attach / readInterruptedTurn', () => {
  it('挂在错误上后能读回，且不影响错误本身', () => {
    const err = new Error('SSE 流空闲超过 60000ms') as Error & { code?: string };
    err.code = 'AGENT_FAILED';
    const turn: InterruptedTurn = {
      partial: { resultText: 'half', toolCalls: [] },
      reason: 'upstream_error',
      meta,
    };
    attachInterruptedTurn(err, turn);
    expect(err.message).toBe('SSE 流空闲超过 60000ms'); // 报错信息不变
    expect(err.code).toBe('AGENT_FAILED'); // 分类码不变
    expect(readInterruptedTurn(err)).toEqual(turn);
  });

  it('普通错误读不到中断信息，返回 null', () => {
    expect(readInterruptedTurn(new Error('plain'))).toBeNull();
    expect(readInterruptedTurn(undefined)).toBeNull();
  });
});
