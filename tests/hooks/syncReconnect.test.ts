/** @vitest-environment jsdom */
/**
 * 四个 sync hook 断线重连后重拉（M7）——挂载各拉一次初值，重连（onStatus 'open' 非首次）再拉一次。
 * 修前它们只在挂载拉一次、不听 onStatus：断线期漏掉的增量（后台命令结束、信号消解等）永不补齐，
 * 「运行中脉冲」永久挂着无自愈。这里钉住「重连即重拉」，与 App.resyncServerState 同一套重连口径。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { OruWsClient, WsStatus } from '@/lib/ws';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';

const ws = vi.hoisted(() => ({
  status: 'open' as WsStatus,
  statusHandlers: new Set<(s: WsStatus) => void>(),
  requests: [] as ClientRequestPayload[],
  emit(s: WsStatus) {
    ws.status = s;
    for (const h of ws.statusHandlers) h(s);
  },
}));

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(p: ClientRequestPayload): Promise<T> => {
      ws.requests.push(p);
      // 各 store 的 apply 按 res.type 守卫，非目标 type 即 no-op——回个中性包即可，不触发状态改写
      return { type: 'noop' } as unknown as T;
    },
    subscribe: () => () => {},
    onStatus: (h: (s: WsStatus) => void) => {
      ws.statusHandlers.add(h);
      return () => ws.statusHandlers.delete(h);
    },
    ready: async () => {},
    status: () => ws.status,
  } satisfies OruWsClient,
}));

import { useScheduledTaskSync } from '@/hooks/useScheduledTaskSync';
import { useBgCommandSync } from '@/hooks/useBgCommandSync';
import { useSystemSignalSync } from '@/hooks/useSystemSignalSync';
import { useTaskboardSync } from '@/hooks/useTaskboardSync';

const countOf = (type: string): number => ws.requests.filter((r) => r.type === type).length;

/** 让 hook 内的 microtask（request / ready().then）落定 */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  ws.status = 'open';
  ws.statusHandlers.clear();
  ws.requests = [];
});
afterEach(() => cleanup());

describe('sync hook 断线重连重拉（M7）', () => {
  it.each([
    ['useScheduledTaskSync', useScheduledTaskSync, 'scheduledTask.list'],
    ['useBgCommandSync', useBgCommandSync, 'bgCommand.list'],
    ['useSystemSignalSync', useSystemSignalSync, 'system.signals.list'],
    ['useTaskboardSync', useTaskboardSync, 'taskboard.list'],
  ] as const)('%s：挂载拉一次，重连再拉一次', async (_name, hook, reqType) => {
    renderHook(() => hook());
    await flush();
    expect(countOf(reqType)).toBe(1); // 挂载初值

    ws.emit('closed'); // 断线
    ws.emit('open'); // 重连
    await flush();
    expect(countOf(reqType)).toBe(2); // 重连重拉
  });
});
