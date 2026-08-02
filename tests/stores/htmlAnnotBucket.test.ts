// @vitest-environment jsdom

/**
 * htmlAnnotStore 按 ref 分桶（tech design §3.6 §六回归）。
 *
 * 核心断言：两个 html 标签各自标注/提交/对比互不串改；身份口径——桶 key = 项目相对 ref、
 * WS htmlPath = 绝对路径、广播按绝对路径找桶——三处一致才不串/丢。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Annotation } from '@shared/types';

// mock WS：activate 回该 html 的标注（按绝对 htmlPath 区分两个文件）；动作记录发出的 htmlPath。
const sentPaths: string[] = [];
const requestMock = vi.fn((req: { type: string; htmlPath?: string }) => {
  sentPaths.push(`${req.type}:${req.htmlPath ?? ''}`);
  if (req.type === 'html.activate') {
    const ann: Annotation[] =
      req.htmlPath === '/proj/a.html'
        ? [{ id: 'a1', comment: 'A', status: 'pending' } as unknown as Annotation]
        : [{ id: 'b1', comment: 'B', status: 'pending' } as unknown as Annotation];
    return Promise.resolve({ type: 'html.activate.result', annotations: ann, submission: null });
  }
  return Promise.resolve({ type: 'ack' });
});
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useHtmlAnnotStore } from '@/stores/htmlAnnotStore';

describe('htmlAnnotStore 两个 html 标签不串（§六回归）', () => {
  beforeEach(() => {
    requestMock.mockClear();
    sentPaths.length = 0;
    useHtmlAnnotStore.setState({ byRef: {} });
  });

  it('各自 activate 后标注落各自桶，互不覆盖', async () => {
    await useHtmlAnnotStore.getState().activate('a.html', '/proj/a.html');
    await useHtmlAnnotStore.getState().activate('b.html', '/proj/b.html');
    const s = useHtmlAnnotStore.getState();
    expect(s.byRef['a.html']!.annotations.map((a) => a.id)).toEqual(['a1']);
    expect(s.byRef['b.html']!.annotations.map((a) => a.id)).toEqual(['b1']);
    // WS htmlPath = 绝对路径（两个文件各发自己的绝对路径）
    expect(sentPaths).toContain('html.activate:/proj/a.html');
    expect(sentPaths).toContain('html.activate:/proj/b.html');
  });

  it('广播按绝对路径找桶：只更新匹配的那个', async () => {
    await useHtmlAnnotStore.getState().activate('a.html', '/proj/a.html');
    await useHtmlAnnotStore.getState().activate('b.html', '/proj/b.html');
    // 广播给 a 的绝对路径 → 只动 a 桶
    useHtmlAnnotStore
      .getState()
      .syncAnnotations('/proj/a.html', [{ id: 'a2', comment: 'A2', status: 'pending' } as unknown as Annotation]);
    const s = useHtmlAnnotStore.getState();
    expect(s.byRef['a.html']!.annotations.map((a) => a.id)).toEqual(['a2']);
    expect(s.byRef['b.html']!.annotations.map((a) => a.id)).toEqual(['b1']); // b 不受影响
  });

  it('未打开的 html 广播被丢弃（桶不在）', async () => {
    await useHtmlAnnotStore.getState().activate('a.html', '/proj/a.html');
    useHtmlAnnotStore.getState().syncAnnotations('/proj/nope.html', []);
    expect(Object.keys(useHtmlAnnotStore.getState().byRef)).toEqual(['a.html']);
  });

  it('动作（addAnnotation）发本桶 absPath，不串到另一桶', async () => {
    await useHtmlAnnotStore.getState().activate('a.html', '/proj/a.html');
    await useHtmlAnnotStore.getState().activate('b.html', '/proj/b.html');
    sentPaths.length = 0;
    await useHtmlAnnotStore.getState().addAnnotation('b.html', { comment: '', htmlSnippet: '', text: '' });
    expect(sentPaths).toEqual(['html.addAnnotation:/proj/b.html']);
  });

  it('frameSelectSignal / reloadSignal 各桶独立自增', async () => {
    await useHtmlAnnotStore.getState().activate('a.html', '/proj/a.html');
    await useHtmlAnnotStore.getState().activate('b.html', '/proj/b.html');
    useHtmlAnnotStore.getState().requestFrameSelect('a.html');
    useHtmlAnnotStore.getState().notifyIndexChanged('/proj/b.html');
    const s = useHtmlAnnotStore.getState();
    expect(s.byRef['a.html']!.frameSelectSignal).toBe(1);
    expect(s.byRef['b.html']!.frameSelectSignal).toBe(0);
    expect(s.byRef['b.html']!.reloadSignal).toBe(1);
    expect(s.byRef['a.html']!.reloadSignal).toBe(0);
  });

  it('deactivate 只删该桶', async () => {
    await useHtmlAnnotStore.getState().activate('a.html', '/proj/a.html');
    await useHtmlAnnotStore.getState().activate('b.html', '/proj/b.html');
    useHtmlAnnotStore.getState().deactivate('a.html');
    expect(Object.keys(useHtmlAnnotStore.getState().byRef)).toEqual(['b.html']);
  });
});
