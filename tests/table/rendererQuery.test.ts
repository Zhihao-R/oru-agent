/**
 * rendererQuery —— main → renderer 通用查询信箱（dirtySet/draft 两 kind）。
 * 防线照抄 pendingDecision：先挂 waiter 再 emit、take-once（首答生效后到丢弃）、超时 settle。
 * 无 UI（无客户端连接）时 dirtySet 按空集应答——没有渲染进程就没有草稿，这是语义正确而非降级。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEventPayload } from '@shared/protocol';
import {
  rendererQuery,
  resetRendererQueryForTest,
  resolveRendererQuery,
  setRendererQueryDeps,
} from '../../electron/main/agent/rendererQuery';

let sent: ServerEventPayload[];
let clients: number;

beforeEach(() => {
  sent = [];
  clients = 1;
  resetRendererQueryForTest();
  setRendererQueryDeps({
    broadcast: (e) => {
      sent.push(e);
    },
    hasClients: () => clients > 0,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const lastQueryId = (): string => {
  const ev = sent[sent.length - 1];
  if (ev?.type !== 'renderer.query') throw new Error('no renderer.query emitted');
  return ev.queryId;
};

describe('rendererQuery', () => {
  it('emit renderer.query，应答后 resolve（take-once：后到丢弃）', async () => {
    const p = rendererQuery<{ paths: string[] }>('dirtySet', {}, 1000);
    const id = lastQueryId();
    expect(resolveRendererQuery(id, { paths: ['a.csv'] })).toBe(true);
    expect(resolveRendererQuery(id, { paths: ['迟到的'] })).toBe(false); // 多窗口双应答：首答生效
    expect(await p).toEqual({ paths: ['a.csv'] });
  });

  it('超时 reject（出口闸门据此保守拦截）', async () => {
    vi.useFakeTimers();
    const p = rendererQuery('dirtySet', {}, 50);
    const assertion = expect(p).rejects.toThrow(/超时/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
  });

  it('无客户端连接：dirtySet 立即返回空集，不挂 waiter', async () => {
    clients = 0;
    expect(await rendererQuery<{ paths: string[] }>('dirtySet', {}, 50)).toEqual({ paths: [] });
    expect(sent).toEqual([]);
  });

  it('无客户端连接：draft 查询 reject（读路径由调用方降级读磁盘）', async () => {
    clients = 0;
    await expect(rendererQuery('draft', { path: 'a.md' }, 50)).rejects.toThrow();
  });

  it('未知 queryId 的应答返回 false 不抛', () => {
    expect(resolveRendererQuery('q_unknown', {})).toBe(false);
  });
});
