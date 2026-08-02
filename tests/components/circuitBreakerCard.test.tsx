/** @vitest-environment jsdom */
/**
 * 断路器跳闸卡（G01/G04）——渲染标题 + 按 reason 的说明 + 「继续放行 / 停止」两钮；
 * disabled 时置灰不可点。锁 reason→文案 映射与两个动作钮不被回归漏渲染。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CircuitBreakerCard } from '@/components/chat/CircuitBreakerCard';
import type { CircuitBreakPending } from '@/stores/chatStore';

function makeBreak(overrides: Partial<CircuitBreakPending> = {}): CircuitBreakPending {
  return {
    breakerId: 'brk1',
    conversationId: 'c1',
    messageId: 'm1',
    reason: 'consecutive-failures',
    ...overrides,
  };
}

afterEach(cleanup);

describe('CircuitBreakerCard（G01/G04）', () => {
  it('连续失败 → 标题 + 说明 + 两个动作钮', () => {
    render(<CircuitBreakerCard brk={makeBreak()} />);
    expect(screen.getByText('已自动暂停')).toBeTruthy();
    expect(screen.getByText(/连续多次失败/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '继续放行' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '停止' })).toBeTruthy();
  });

  it('高频 reason → 换对应说明', () => {
    render(<CircuitBreakerCard brk={makeBreak({ reason: 'high-frequency' })} />);
    expect(screen.getByText(/异常频繁/)).toBeTruthy();
  });

  it('disabled → 两钮均置灰不可点', () => {
    render(<CircuitBreakerCard brk={makeBreak({ disabled: true })} />);
    expect(screen.getByRole('button', { name: '继续放行' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: '停止' }).hasAttribute('disabled')).toBe(true);
  });
});
