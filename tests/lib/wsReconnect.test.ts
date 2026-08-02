/** @vitest-environment jsdom */
/**
 * onReconnect：断线重连（onStatus 'open' 且非首次连接）才触发重拉。
 * 首次 'open' 属初始连接、由调用点自己的挂载加载负责，不在此重复（避免启动双拉）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WsStatus } from '@/lib/ws';

const ws = vi.hoisted(() => ({
  status: 'connecting' as WsStatus,
  handlers: new Set<(s: WsStatus) => void>(),
  emit(s: WsStatus) {
    ws.status = s;
    for (const h of ws.handlers) h(s);
  },
}));

vi.mock('@/lib/ws', () => ({
  wsClient: {
    status: () => ws.status,
    onStatus: (h: (s: WsStatus) => void) => {
      ws.handlers.add(h);
      return () => ws.handlers.delete(h);
    },
  },
}));

import { onReconnect } from '@/lib/wsReconnect';

beforeEach(() => {
  ws.status = 'connecting';
  ws.handlers.clear();
});

describe('onReconnect', () => {
  it('订阅时处于 connecting：首次 open 不触发（初始连接），重连的 open 才触发', () => {
    const fn = vi.fn();
    onReconnect(fn);
    ws.emit('open'); // 首次连上——初始加载负责，不重拉
    expect(fn).not.toHaveBeenCalled();
    ws.emit('closed'); // 断线
    ws.emit('open'); // 重连
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('订阅时已 open：下一次 open（重连）即触发', () => {
    ws.status = 'open';
    const fn = vi.fn();
    onReconnect(fn);
    ws.emit('closed');
    ws.emit('open');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('非 open 状态不触发', () => {
    const fn = vi.fn();
    onReconnect(fn);
    ws.emit('closed');
    ws.emit('connecting');
    expect(fn).not.toHaveBeenCalled();
  });

  it('退订后重连不再触发', () => {
    ws.status = 'open';
    const fn = vi.fn();
    const unsub = onReconnect(fn);
    unsub();
    ws.emit('closed');
    ws.emit('open');
    expect(fn).not.toHaveBeenCalled();
  });
});
