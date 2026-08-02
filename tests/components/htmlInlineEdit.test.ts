// @vitest-environment jsdom

/**
 * useHtmlInlineEdit —— HTML 预览「右键改字」写回回路（Task 6）。
 *
 * 验真实行为，不只验 mock 被调：
 * - 唯一编辑 → 发出 fs.applyTextEdit payload 正确（含基线 expectedMtimeMs），且**不**触发任何 reload/重渲染；
 * - DEGRADED → 向 webview send 'inline:editRejected'（preload 回滚 DOM）；
 * - CONFLICT → 向 webview send 'inline:editConflict'（回滚 + 提示先刷新）；
 * - 切文件竞态：A 编辑成功后 refreshBaseline 的 stat 迟到 resolve，不得污染 B 的基线；
 * - 基线正向推进：写成功后下次编辑携带 refreshBaseline 后的新 mtime。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook } from '@testing-library/react';
import type { OruWsClient } from '@/lib/ws';
import { ErrorCodes } from '@shared/types';

const requestMock = vi.fn();
// mock satisfies 被 mock 的接口（CLAUDE.md 硬约束）——接口加字段时此处假绿会被类型报出
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open',
  } satisfies OruWsClient,
}));

import { useHtmlInlineEdit } from '@/components/useHtmlInlineEdit';

const HTML_PATH = '/abs/project/report.html';
const HTML_PATH_B = '/abs/project/other.html';
const BASELINE = 1717000000000;

/** 可外部控制 resolve 时机的 promise（制造「stat 迟到」）。 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

/** 最小 webview 替身：只实现 hook 真正用的 send + ipc-message 监听 + reload 探针。 */
function makeWebview() {
  const el = document.createElement('div') as unknown as HTMLElement & {
    send: ReturnType<typeof vi.fn>;
    reload: ReturnType<typeof vi.fn>;
  };
  el.send = vi.fn();
  el.reload = vi.fn();
  return el;
}

/** 在 webview 上派一个 inline:edited ipc-message（带 channel/args，照 PreviewPane 的事件形态）。 */
function emitEdited(el: HTMLElement, payload: { markerId: string | null; oldText: string; newText: string }) {
  const ev = new Event('ipc-message') as Event & { channel: string; args: unknown[] };
  ev.channel = 'inline:edited';
  ev.args = [{ ...payload, pageIndex: 0 }];
  el.dispatchEvent(ev);
}

/** 等微任务队列排空——hook 的 onMsg 是 async，断言前让 request/分流跑完。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  requestMock.mockReset();
  // 默认：打开取基线 fs.stat 成功
  requestMock.mockImplementation((req: { type: string }) => {
    if (req.type === 'fs.stat') return Promise.resolve({ type: 'fs.stat.result', mtimeMs: BASELINE });
    return Promise.resolve({ type: 'ack' });
  });
});
afterEach(cleanup);

describe('useHtmlInlineEdit — 改字回路', () => {
  it('唯一编辑 → 发出正确 payload（含基线），且不 reload/重渲染', async () => {
    const wv = makeWebview();
    renderHook(() => useHtmlInlineEdit(HTML_PATH, wv));
    await flush(); // 打开取基线落定

    emitEdited(wv, { markerId: 'm-1', oldText: '<b>旧</b>', newText: '<b>新</b>' });
    await flush();

    const applyCall = requestMock.mock.calls.find((c) => (c[0] as { type: string }).type === 'fs.applyTextEdit');
    expect(applyCall?.[0]).toEqual({
      type: 'fs.applyTextEdit',
      filePath: HTML_PATH,
      markerId: 'm-1',
      oldText: '<b>旧</b>',
      newText: '<b>新</b>',
      expectedMtimeMs: BASELINE,
    });
    // 不 reload：成功路径绝不重载整页（DOM 已是最新）
    expect(wv.reload).not.toHaveBeenCalled();
    // 成功路径不向 webview 回发任何回滚事件
    expect(wv.send).not.toHaveBeenCalled();
  });

  it('基线 stat 未成功 → payload 不带 expectedMtimeMs（main 跳过校验）', async () => {
    requestMock.mockImplementation((req: { type: string }) => {
      if (req.type === 'fs.stat') return Promise.reject(new Error('no such file'));
      return Promise.resolve({ type: 'ack' });
    });
    const wv = makeWebview();
    renderHook(() => useHtmlInlineEdit(HTML_PATH, wv));
    await flush();

    emitEdited(wv, { markerId: null, oldText: '甲', newText: '乙' });
    await flush();

    const applyCall = requestMock.mock.calls.find((c) => (c[0] as { type: string }).type === 'fs.applyTextEdit');
    expect(applyCall?.[0]).not.toHaveProperty('expectedMtimeMs');
  });

  it('DEGRADED（定位降级）→ 向 webview send inline:editRejected', async () => {
    const wv = makeWebview();
    renderHook(() => useHtmlInlineEdit(HTML_PATH, wv));
    await flush();

    requestMock.mockImplementation((req: { type: string }) => {
      if (req.type === 'fs.stat') return Promise.resolve({ type: 'fs.stat.result', mtimeMs: BASELINE });
      const err = new Error('degraded') as Error & { code?: string };
      err.code = ErrorCodes.FS_TEXT_EDIT_DEGRADED;
      return Promise.reject(err);
    });
    emitEdited(wv, { markerId: null, oldText: '只此一处', newText: '改了' });
    await flush();

    expect(wv.send).toHaveBeenCalledWith('inline:editRejected');
    expect(wv.send).not.toHaveBeenCalledWith('inline:editConflict');
  });

  it('CONFLICT（基线失配）→ 走 inline:editConflict（回滚 + 提示刷新），不发 editRejected', async () => {
    const wv = makeWebview();
    renderHook(() => useHtmlInlineEdit(HTML_PATH, wv));
    await flush();

    requestMock.mockImplementation((req: { type: string }) => {
      if (req.type === 'fs.stat') return Promise.resolve({ type: 'fs.stat.result', mtimeMs: BASELINE });
      const err = new Error('conflict') as Error & { code?: string };
      err.code = ErrorCodes.FS_TEXT_EDIT_CONFLICT;
      return Promise.reject(err);
    });
    emitEdited(wv, { markerId: null, oldText: '只此一处', newText: '改了' });
    await flush();

    expect(wv.send).toHaveBeenCalledWith('inline:editConflict');
    expect(wv.send).not.toHaveBeenCalledWith('inline:editRejected');
  });

  it('io/未知错误（main 回 UNKNOWN）→ 走 inline:editFailed（回滚 + 提示重试），不复用 editRejected/editConflict', async () => {
    const wv = makeWebview();
    renderHook(() => useHtmlInlineEdit(HTML_PATH, wv));
    await flush();

    requestMock.mockImplementation((req: { type: string }) => {
      if (req.type === 'fs.stat') return Promise.resolve({ type: 'fs.stat.result', mtimeMs: BASELINE });
      // io/超时/断连：main 把 io 折成 UNKNOWN；未知错误同样落这条分支
      const err = new Error('io') as Error & { code?: string };
      err.code = ErrorCodes.UNKNOWN;
      return Promise.reject(err);
    });
    emitEdited(wv, { markerId: null, oldText: '只此一处', newText: '改了' });
    await flush();

    expect(wv.send).toHaveBeenCalledWith('inline:editFailed');
    expect(wv.send).not.toHaveBeenCalledWith('inline:editRejected');
    expect(wv.send).not.toHaveBeenCalledWith('inline:editConflict');
  });

  it('基线正向推进：写成功后下次编辑携带 refreshBaseline 后的新 mtime', async () => {
    const NEW_MTIME = BASELINE + 5000;
    let statCount = 0;
    requestMock.mockImplementation((req: { type: string }) => {
      if (req.type === 'fs.stat') {
        // 第 1 次 stat = 打开取基线（BASELINE）；第 2 次 = 写成功后 refreshBaseline（NEW_MTIME）
        statCount += 1;
        return Promise.resolve({ type: 'fs.stat.result', mtimeMs: statCount === 1 ? BASELINE : NEW_MTIME });
      }
      return Promise.resolve({ type: 'ack' });
    });
    const wv = makeWebview();
    renderHook(() => useHtmlInlineEdit(HTML_PATH, wv));
    await flush(); // 打开取基线 = BASELINE

    emitEdited(wv, { markerId: 'm-1', oldText: 'a', newText: 'b' });
    await flush(); // 第一次写：带 BASELINE；refreshBaseline 把基线推进到 NEW_MTIME

    emitEdited(wv, { markerId: 'm-2', oldText: 'c', newText: 'd' });
    await flush();

    const applyCalls = requestMock.mock.calls.filter((c) => (c[0] as { type: string }).type === 'fs.applyTextEdit');
    expect(applyCalls).toHaveLength(2);
    // 第一次编辑带打开基线
    expect(applyCalls[0]?.[0]).toMatchObject({ expectedMtimeMs: BASELINE });
    // 第二次编辑带 refreshBaseline 后的新值（直接断言新 mtime，不靠「不报 conflict」间接验）
    expect(applyCalls[1]?.[0]).toMatchObject({ expectedMtimeMs: NEW_MTIME });
  });

  it('切文件竞态：A 编辑成功后 refreshBaseline 的 stat 迟到 resolve，不污染 B 的基线', async () => {
    const A_NEW_MTIME = BASELINE + 9999; // A 写后的新 mtime（迟到 stat 想写的值）
    const B_BASELINE = 1818000000000; // B 打开时的基线
    const lateStatA = deferred<{ type: 'fs.stat.result'; mtimeMs: number }>();
    let statCount = 0;

    requestMock.mockImplementation((req: { type: string; filePath?: string }) => {
      if (req.type === 'fs.stat') {
        statCount += 1;
        if (statCount === 1) {
          // A 打开取基线
          return Promise.resolve({ type: 'fs.stat.result', mtimeMs: BASELINE });
        }
        if (statCount === 2) {
          // A 写成功后的 refreshBaseline——返回受控 deferred，故意「迟到」
          return lateStatA.promise;
        }
        // B 打开取基线（第 3 次）
        return Promise.resolve({ type: 'fs.stat.result', mtimeMs: B_BASELINE });
      }
      return Promise.resolve({ type: 'ack' });
    });

    const wv = makeWebview();
    const { rerender } = renderHook(({ p }) => useHtmlInlineEdit(p, wv), {
      initialProps: { p: HTML_PATH },
    });
    await flush(); // A 取基线 = BASELINE

    // A 编辑成功 → 触发 refreshBaseline（statCount 2，挂在 lateStatA 上，尚未 resolve）
    emitEdited(wv, { markerId: 'm-a', oldText: 'a', newText: 'b' });
    await flush();

    // 切到 B：旧 effect cleanup 置 alive=false，B 重新取基线 = B_BASELINE
    rerender({ p: HTML_PATH_B });
    await flush();

    // 此刻 A 的 refreshBaseline stat 才迟到 resolve（想把 A_NEW_MTIME 写进基线）
    lateStatA.resolve({ type: 'fs.stat.result', mtimeMs: A_NEW_MTIME });
    await flush();

    // B 下一次编辑——expectedMtimeMs 必须是 B 的基线，绝不能是 A 迟到 stat 的值
    emitEdited(wv, { markerId: 'm-b', oldText: 'c', newText: 'd' });
    await flush();

    const applyB = requestMock.mock.calls
      .filter((c) => (c[0] as { type: string; filePath?: string }).type === 'fs.applyTextEdit')
      .map((c) => c[0] as { filePath?: string; expectedMtimeMs?: number })
      .find((p) => p.filePath === HTML_PATH_B);
    expect(applyB?.expectedMtimeMs).toBe(B_BASELINE);
    expect(applyB?.expectedMtimeMs).not.toBe(A_NEW_MTIME);
  });

  it('卸载后摘除 ipc-message 监听（不再发请求）', async () => {
    const wv = makeWebview();
    const { unmount } = renderHook(() => useHtmlInlineEdit(HTML_PATH, wv));
    await flush();
    unmount();
    requestMock.mockClear();

    emitEdited(wv, { markerId: null, oldText: 'x', newText: 'y' });
    await flush();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
