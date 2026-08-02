/**
 * WS 客户端断线处理（审计 N1）
 *
 * close 时必须立即 reject 所有在途请求并清空 pending——否则白等到超时，
 * 且 reqId 复用会把新连接的响应错配到旧 pending。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

class FakeWS {
  static OPEN = 1;
  static instances: FakeWS[] = [];
  readyState = 0;
  url: string;
  private listeners: Record<string, Array<(ev: unknown) => void>> = {};
  constructor(url: string) {
    this.url = url;
    FakeWS.instances.push(this);
  }
  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }
  send(): void {}
  emit(type: string): void {
    (this.listeners[type] ?? []).forEach((f) => f({}));
  }
}

async function loadClient() {
  vi.resetModules();
  FakeWS.instances = [];
  vi.stubGlobal('window', { __ORU__: { wsPort: 9999 } });
  vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
  const mod = await import('../../src/lib/ws');
  return mod.wsClient;
}

describe('wsClient 断线处理 (N1)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('close 时在途请求立即 reject，不白等超时', async () => {
    const client = await loadClient();
    const sock = FakeWS.instances[0];
    sock.readyState = FakeWS.OPEN;
    sock.emit('open');

    const p = client.request({ type: 'noop' } as never).catch((e: Error) => e);
    sock.emit('close');

    const err = await p;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/断开/);
  });

  it('close 后 pending 清空——旧 reqId 的迟到响应不会错配', async () => {
    const client = await loadClient();
    const sock = FakeWS.instances[0];
    sock.readyState = FakeWS.OPEN;
    sock.emit('open');

    let settled = false;
    const p = client
      .request({ type: 'noop' } as never)
      .then(() => (settled = true))
      .catch(() => (settled = true));
    sock.emit('close');
    await p;
    expect(settled).toBe(true); // 已被 close 落定，不再悬挂等迟到响应
  });
});
