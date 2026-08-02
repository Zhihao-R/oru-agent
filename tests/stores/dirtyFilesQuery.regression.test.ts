/**
 * bindRendererQueries 应答链健壮性（bug 2026-08-01「编辑器无响应」闸门被卡）：
 * renderer.query(dirtySet) 到达时，flushAll 若未预期 reject，queryResult 仍必须发出——
 * 否则 main 侧 2s 超时走「编辑器无响应」保守拦截，bash / 写文件全被闸门卡死。
 * 回归：distulide flush 失败不应掐断应答链。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '@shared/protocol';

const requestMock = vi.fn();
let listener: ((ev: ServerEvent) => void) | null = null;
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: (cb: (ev: ServerEvent) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { bindRendererQueries, __resetBindRendererQueriesForTest } from '@/lib/dirtyFiles';
import { useEditorStore } from '@/stores/editorStore';
import { useTableStore } from '@/stores/tableStore';

const flushEditorAll = vi.fn();
const flushTableAll = vi.fn();

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ type: 'renderer.queryResult' });
  listener = null;
  __resetBindRendererQueriesForTest();
  // stub 两个 store 的 flushAll，让测试可控地注入 reject
  useEditorStore.setState({ flushAll: flushEditorAll } as never);
  useTableStore.setState({ flushAll: flushTableAll } as never);
  // 重置 tables：前用例（q1）会 set 脏表进 store，不重置会残留污染后续用例的脏集断言
  useTableStore.setState({ tables: {} } as never);
});

afterEach(() => {
  vi.useRealTimers(); // 兜底：无论用例成败都还原 fake timers，防泄漏到后续用例
  vi.restoreAllMocks();
});

describe('bindRendererQueries · dirtySet 应答链（2026-08-01 闸门卡死回归）', () => {
  it('flushAll 正常 → 发出 queryResult（路径按脏集如实报）', async () => {
    flushEditorAll.mockResolvedValue(undefined);
    flushTableAll.mockResolvedValue(undefined);
    flushTableAll.mockImplementation(async () => {
      // 构造一张脏表，验证脏集如实上报
      useTableStore.setState({
        tables: {
          '/tmp/a.csv': { dirty: true } as never,
        },
      } as never);
    });

    bindRendererQueries();
    listener!({ type: 'renderer.query', queryId: 'q1', kind: 'dirtySet' } as never);

    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'renderer.queryResult',
          queryId: 'q1',
          result: { paths: ['/tmp/a.csv'] },
        }),
      );
    });
  });

  it('flushAll reject → 仍照常发出 queryResult（应答不被掐断）', async () => {
    flushEditorAll.mockResolvedValue(undefined);
    flushTableAll.mockRejectedValue(new Error('表落盘失败'));

    bindRendererQueries();
    listener!({ type: 'renderer.query', queryId: 'q2', kind: 'dirtySet' } as never);

    await vi.waitFor(() => {
      expect(requestMock).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'renderer.queryResult',
          queryId: 'q2',
        }),
      );
    });
    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('flushAll 挂起不 resolve → cap(1200ms) 到期返回当前脏集并照常发 queryResult（2026-08-02 路线 X 兜底）', async () => {
    // 护栏：flush 永不 resolve（模拟 conflictCard / encodingSafe 确认框挂起），推进 cap 到期。
    // 断言 cap 到期后 queryResult 照发、且脏集按「当前（即使过期）tables」如实上报——
    // 这正是 X 的语义边界（推进到 cap 前的未落盘脏集仍会返回，可能漏拦是有意取舍）。
    // 测的是「cap 到期能应答 + 取当前脏集」这个机制本身，非真实挂起原子。
    vi.useFakeTimers();
    flushEditorAll.mockImplementation(() => new Promise(() => {})); // 永不 resolve
    flushTableAll.mockImplementation(() => new Promise(() => {})); // 永不 resolve
    useTableStore.setState({
      tables: {
        '/tmp/hang.csv': { dirty: true } as never,
      },
    } as never);

    bindRendererQueries();
    listener!({ type: 'renderer.query', queryId: 'q3', kind: 'dirtySet' } as never);

    // 让 cap 的 setTimeout 触发（1200ms），挂起的 flush 照旧不 resolve
    await vi.advanceTimersByTimeAsync(1200);

    // cap 到期后照常发出 queryResult，脏集按当前 tables 如实上报（含未落盘的 /tmp/hang.csv）
    expect(requestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'renderer.queryResult',
        queryId: 'q3',
        result: { paths: ['/tmp/hang.csv'] },
      }),
    );
    expect(requestMock).toHaveBeenCalledTimes(1);
  });
});
