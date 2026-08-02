/** @vitest-environment jsdom */
/**
 * toastStore（M8）——写操作失败的瞬时全局提示队列。挂载时无、show 追加、到时自动消、超上限留最新。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastStore } from '@/stores/toastStore';
import { toastError } from '@/lib/toast';

beforeEach(() => {
  vi.useFakeTimers();
  useToastStore.setState({ toasts: [] });
});
afterEach(() => vi.useRealTimers());

describe('toastStore', () => {
  it('show 追加一条 toast，返回其 id', () => {
    const id = useToastStore.getState().show('更新失败');
    const { toasts } = useToastStore.getState();
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ id, message: '更新失败' });
  });

  it('到时（4s）自动消失', () => {
    useToastStore.getState().show('x');
    expect(useToastStore.getState().toasts).toHaveLength(1);
    vi.advanceTimersByTime(4000);
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('dismiss 只移除指定 id，不误伤其他', () => {
    const a = useToastStore.getState().show('a');
    useToastStore.getState().show('b');
    useToastStore.getState().dismiss(a);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['b']);
  });

  it('超过上限只留最新 3 条（不无界堆叠）', () => {
    for (let i = 0; i < 5; i += 1) useToastStore.getState().show(`m${i}`);
    expect(useToastStore.getState().toasts.map((t) => t.message)).toEqual(['m2', 'm3', 'm4']);
  });

  it('toastError 便捷入口 → store.show', () => {
    toastError('boom');
    expect(useToastStore.getState().toasts[0]).toMatchObject({ message: 'boom' });
  });
});
