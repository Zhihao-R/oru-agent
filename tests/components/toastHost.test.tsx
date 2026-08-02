/** @vitest-environment jsdom */
/**
 * ToastHost（M8）——渲染 toastStore 队列、点关闭移除。空队列不渲染任何东西。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { ToastHost } from '@/components/ToastHost';
import { useToastStore } from '@/stores/toastStore';

beforeEach(() => useToastStore.setState({ toasts: [] }));
afterEach(() => cleanup());

describe('ToastHost', () => {
  it('空队列时不渲染 alert', () => {
    render(<ToastHost />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('渲染队列中的消息', () => {
    useToastStore.setState({ toasts: [{ id: 1, message: '更新状态失败，请重试' }] });
    render(<ToastHost />);
    expect(screen.getByRole('alert').textContent).toContain('更新状态失败，请重试');
  });

  it('点关闭按钮移除该条', () => {
    useToastStore.setState({ toasts: [{ id: 7, message: '保存失败' }] });
    render(<ToastHost />);
    fireEvent.click(screen.getByRole('button'));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});
