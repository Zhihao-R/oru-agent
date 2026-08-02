/** @vitest-environment jsdom */
/**
 * Loop 模式：状态是 boolean（loopModeByConv），呈现为文字开头一枚 `/loop` 标签——草稿文字保持干净，
 * 送出时才前置 `/loop `（backend parseLoopCommand 契约）。覆盖：按钮开关、手打 /loop 自动识别、
 * 退格删标签、发送前置前缀并复位、按钮高亮。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChatInput } from '@/components/chat/ChatInput';
import { useChatStore } from '@/stores/chatStore';

const CONV = 'c-loop';

// 开关按钮的 label 以「Loop 模式」开头（loopOn/loopOff 两态）；标签的删除键是「取消 Loop 模式」，
// 用 /^Loop 模式/ 精确圈定开关按钮、避开删除键。
function loopButton() {
  return screen.getByRole('button', { name: /^Loop 模式/ });
}
function loopModeOn() {
  return useChatStore.getState().loopModeByConv[CONV] === true;
}
function draft() {
  return useChatStore.getState().draftTextByConv[CONV] ?? '';
}

beforeEach(() => {
  useChatStore.setState({ draftTextByConv: {}, loopModeByConv: {} });
});

afterEach(cleanup);

describe('Loop 模式：boolean 状态 + /loop 标签', () => {
  it('点按钮开关：置位 loopMode，草稿文字不被改写', () => {
    useChatStore.setState({ draftTextByConv: { [CONV]: '写周报' } });
    render(<ChatInput conversationId={CONV} onSend={() => {}} />);

    fireEvent.click(loopButton());
    expect(loopModeOn()).toBe(true);
    expect(draft()).toBe('写周报'); // 文字保持干净，不塞 /loop

    fireEvent.click(loopButton());
    expect(loopModeOn()).toBe(false);
    expect(draft()).toBe('写周报');
  });

  it('开启时渲染 /loop 标签，可点 × 取消', () => {
    render(<ChatInput conversationId={CONV} onSend={() => {}} />);
    fireEvent.click(loopButton());

    expect(screen.getByText('/loop')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '取消 Loop 模式' }));
    expect(loopModeOn()).toBe(false);
  });

  it('开头手打 /loop + 空格：自动识别，摘掉前缀只留目标、点亮', () => {
    render(<ChatInput conversationId={CONV} onSend={() => {}} />);
    const ta = screen.getByRole('textbox');

    fireEvent.change(ta, { target: { value: '/loop 写周报' } });
    expect(loopModeOn()).toBe(true);
    expect(draft()).toBe('写周报');
  });

  it('打到一半的 /loop（无空白）不抢先识别', () => {
    render(<ChatInput conversationId={CONV} onSend={() => {}} />);
    const ta = screen.getByRole('textbox');

    fireEvent.change(ta, { target: { value: '/loop' } });
    expect(loopModeOn()).toBe(false);
    expect(draft()).toBe('/loop');
  });

  it('光标在最开头按退格：删掉标签', () => {
    useChatStore.setState({ draftTextByConv: { [CONV]: '写周报' }, loopModeByConv: { [CONV]: true } });
    render(<ChatInput conversationId={CONV} onSend={() => {}} />);
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    ta.setSelectionRange(0, 0);
    expect(ta.selectionStart).toBe(0); // 显式确认「光标在开头」前提成立，再测行为

    fireEvent.keyDown(ta, { key: 'Backspace' });
    expect(loopModeOn()).toBe(false);
    expect(draft()).toBe('写周报'); // 文字不被误删
  });

  it('发送：前置 /loop 前缀并复位 loopMode', () => {
    const onSend = vi.fn();
    useChatStore.setState({ draftTextByConv: { [CONV]: '写周报' }, loopModeByConv: { [CONV]: true } });
    render(<ChatInput conversationId={CONV} onSend={onSend} />);

    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(onSend).toHaveBeenCalledWith('/loop 写周报', undefined);
    expect(loopModeOn()).toBe(false);
    expect(draft()).toBe('');
  });

  it('激活态按钮带高亮底色类（bg-accent-soft），未激活无', () => {
    useChatStore.setState({ loopModeByConv: { [CONV]: true } });
    const { rerender } = render(<ChatInput conversationId={CONV} onSend={() => {}} />);
    expect(loopButton().className).toContain('bg-accent-soft');

    useChatStore.setState({ loopModeByConv: { [CONV]: false } });
    rerender(<ChatInput conversationId={CONV} onSend={() => {}} />);
    expect(loopButton().className).not.toContain('bg-accent-soft');
  });
});
