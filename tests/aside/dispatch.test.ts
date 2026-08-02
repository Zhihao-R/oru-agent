/**
 * aside 分发点（src/aside/dispatch.ts）：单 handler 注册/替换/注销，未注册时静默丢弃。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatchAsideClick, setAsideClickHandler, type AsideClick } from '@/aside/dispatch';

const click: AsideClick = {
  referent: { type: 'blank', label: '文稿预览' },
  position: { x: 10, y: 20 },
};

afterEach(() => {
  setAsideClickHandler(null);
  vi.restoreAllMocks();
});

describe('dispatchAsideClick', () => {
  it('已注册 handler：原样收到 click', () => {
    const received: AsideClick[] = [];
    setAsideClickHandler((c) => received.push(c));
    dispatchAsideClick(click);
    expect(received).toEqual([click]);
  });

  it('未注册 handler：丢弃不抛错（开发期 console.debug）', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(() => dispatchAsideClick(click)).not.toThrow();
    expect(debug).toHaveBeenCalledOnce();
  });

  it('替换 handler：只有新 handler 收到；注销后恢复丢弃', () => {
    const first = vi.fn();
    const second = vi.fn();
    setAsideClickHandler(first);
    setAsideClickHandler(second);
    dispatchAsideClick(click);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(click);

    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    setAsideClickHandler(null);
    dispatchAsideClick(click);
    expect(debug).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});
