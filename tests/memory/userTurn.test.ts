/**
 * isUserAuthoredMessage 判据单测——「用户本人写的真实发言」口径。
 * 主进程记忆抽取按它数轮次、渲染层 ChatArea 置顶气泡按它挑候选，双端共用同一份。
 */
import { describe, it, expect } from 'vitest';
import type { ChatMessage } from '@shared/types';
import { isUserAuthoredMessage, SYSTEM_NOTE_PREFIX } from '@shared/userTurn';

/** 补齐 ChatMessage 必填字段，只让待测语义（role/kind/text）随参变化 */
function msg(over: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'm1',
    conversationId: 'c1',
    role: 'user',
    text: 'hi',
    toolCalls: [],
    createdAt: 1,
    done: true,
    ...over,
  };
}

describe('isUserAuthoredMessage', () => {
  it('role=user、无 kind、非空文本、非系统前缀 → true', () => {
    expect(isUserAuthoredMessage(msg({ role: 'user', text: '你好' }))).toBe(true);
  });

  it('role=assistant → false', () => {
    expect(isUserAuthoredMessage(msg({ role: 'assistant', text: '回答' }))).toBe(false);
  });

  it('任意带 kind（机器写入的消息）→ false', () => {
    expect(isUserAuthoredMessage(msg({ role: 'user', kind: 'scheduled-trigger' }))).toBe(false);
    expect(isUserAuthoredMessage(msg({ role: 'user', kind: 'memory-record' }))).toBe(false);
  });

  it('文本以系统旁白前缀开头 → false', () => {
    expect(
      isUserAuthoredMessage(msg({ role: 'user', text: `${SYSTEM_NOTE_PREFIX}用户拒绝了提案 p1）` })),
    ).toBe(false);
  });

  it('空 / 纯空白文本（纯图消息）→ false', () => {
    expect(isUserAuthoredMessage(msg({ role: 'user', text: '' }))).toBe(false);
    expect(isUserAuthoredMessage(msg({ role: 'user', text: '   \n\t ' }))).toBe(false);
  });

  it('text 为 undefined（防御）→ 不抛、false', () => {
    expect(isUserAuthoredMessage(msg({ role: 'user', text: undefined as unknown as string }))).toBe(false);
  });
});
