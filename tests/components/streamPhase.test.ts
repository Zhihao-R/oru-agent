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
