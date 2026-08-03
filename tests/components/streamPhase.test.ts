import { describe, expect, it } from 'vitest';
import { derivePhase } from '@/lib/streamPhase';
import type { ChatMessage } from '@shared/types';

function msg(p: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'x',
    conversationId: 'c',
    role: 'assistant',
    text: '',
    toolCalls: [],
    createdAt: 0,
    done: false,
    ...p,
  };
}

describe('derivePhase 中断态', () => {
  it('重载的 interrupted 半截（done=true 但 interrupted 有值）→ aborted（显示已中断+重试）', () => {
    expect(derivePhase(msg({ done: true, interrupted: 'upstream_error' }))).toBe('aborted');
  });

  it('正常完成（无 interrupted）→ done（不显示状态行）', () => {
    expect(derivePhase(msg({ done: true }))).toBe('done');
  });

  it('用户主动 abort（abortedByUser）仍 → aborted', () => {
    expect(derivePhase(msg({ abortedByUser: true }))).toBe('aborted');
  });
});

describe('derivePhase 思考→工具→输出流转（Track B 渲染回归）', () => {
  it('思考期（文本空、无 running 工具）→ thinking', () => {
    expect(derivePhase(msg({ text: '', toolCalls: [] }))).toBe('thinking');
  });

  it('进工具（有 running）→ tool，无论文本是否为空', () => {
    expect(
      derivePhase(
        msg({
          text: '',
          toolCalls: [{ id: 't1', name: 'x', status: 'running', input: {} }],
        }),
      ),
    ).toBe('tool');
  });

  it('工具完成后文本流入 → output', () => {
    expect(
      derivePhase(
        msg({
          text: '查到了',
          toolCalls: [{ id: 't1', name: 'x', status: 'done', input: {} }],
        }),
      ),
    ).toBe('output');
  });

  it('done 终态盖过 output/tool', () => {
    expect(
      derivePhase(msg({ text: '结束', done: true, toolCalls: [{ id: 't1', name: 'x', status: 'running', input: {} }] })),
    ).toBe('done');
  });
});
