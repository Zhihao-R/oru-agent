/** @vitest-environment jsdom */
/**
 * PreviewPane webview 元素稳定性回归（真机 bug：profile 翻转换元素 → 监听留旧元素全部失灵）
 *
 * 两条不变量：
 * 1. profile 翻转（deck↔plain，'oru:deckMeta' 到达可触发）前后 webview 是同一个元素——
 *    元素树形状不随 caps 变（letterbox > stagebox > webview 恒定），React 同位复用；
 * 2. 即便元素被换（改 key 强制重挂模拟），监听跟着元素走——新元素上 ipc-message 仍有人消费。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { ArtifactMeta } from '@/stores/artifactStore';

vi.mock('@/lib/ws', () => ({
  wsClient: { request: vi.fn(), subscribe: vi.fn(), send: vi.fn() },
}));
// 大纲条有自己的 store/数据依赖，与本测试无关，掐掉
vi.mock('@/components/deck/OutlineStrip', () => ({ OutlineStrip: () => null }));

import { useArtifactStore } from '@/stores/artifactStore';
import { PreviewPane } from '@/components/deck/PreviewPane';

// jsdom 没有 ResizeObserver（PreviewPane 量 letterbox 用）
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

const DECK_META: ArtifactMeta = { width: 1920, height: 1080, slideCount: 3, profile: 'deck' };
const PLAIN_META: ArtifactMeta = { width: 1920, height: 1080, slideCount: 0, profile: 'plain' };

// 模拟 preload sendToHost 抵达：webview 元素上派发 ipc-message（带 channel/args）
function dispatchIpc(el: Element, channel: string, ...args: unknown[]) {
  const ev = new Event('ipc-message');
  Object.assign(ev, { channel, args });
  act(() => { el.dispatchEvent(ev); });
}

beforeEach(() => {
  useArtifactStore.setState({
    deckMetaByArtifact: { A: DECK_META },
    currentPageIndexByArtifactId: {},
    chromeStateByArtifactId: {},
    compareStateByArtifactId: {},
    jumpSignalByArtifactId: {},
    frameSelectSignalByArtifactId: {},
    reloadSignalByArtifactId: {},
    deckTabByArtifactId: {},
  });
});
afterEach(cleanup);

describe('PreviewPane webview 元素稳定性', () => {
  it('profile 翻转（deck→plain→deck）前后 webview 是同一个元素，且监听始终在线', () => {
    const { container } = render(<PreviewPane artifactId="A" deckPath="/tmp/deckA" isActive />);
    const wv = container.querySelector('webview');
    expect(wv).toBeTruthy();

    // deck → plain（'oru:deckMeta' 推 plain 的真实路径就是 setArtifactMeta）
    act(() => { useArtifactStore.getState().setArtifactMeta('A', PLAIN_META); });
    expect(container.querySelector('webview')).toBe(wv);

    // plain → deck 再翻回来，仍是同一个元素
    act(() => { useArtifactStore.getState().setArtifactMeta('A', DECK_META); });
    expect(container.querySelector('webview')).toBe(wv);

    // 翻转两轮后监听仍在线：webview 上抛 'oru:deckMeta' 应有人消费（写进 store）
    dispatchIpc(wv!, 'oru:deckMeta', { width: 1280, height: 720, slideCount: 5, profile: 'deck' });
    expect(useArtifactStore.getState().deckMetaByArtifact.A).toEqual(
      { width: 1280, height: 720, slideCount: 5, profile: 'deck' },
    );
  });

  it('元素被换（key 强制重挂）→ 监听在新元素上重挂，ipc-message 不静默丢失', () => {
    const { container, rerender } = render(
      <PreviewPane key="a" artifactId="A" deckPath="/tmp/deckA" isActive />,
    );
    const oldWv = container.querySelector('webview');

    rerender(<PreviewPane key="b" artifactId="A" deckPath="/tmp/deckA" isActive />);
    const newWv = container.querySelector('webview');
    expect(newWv).toBeTruthy();
    expect(newWv).not.toBe(oldWv);

    // 新元素上抛 ipc-message：监听必须已迁移到新元素（效果断言，等价于 spy addEventListener）
    dispatchIpc(newWv!, 'oru:deckMeta', { width: 800, height: 600, slideCount: 2, profile: 'deck' });
    expect(useArtifactStore.getState().deckMetaByArtifact.A).toEqual(
      { width: 800, height: 600, slideCount: 2, profile: 'deck' },
    );

    // 旧元素（已脱离文档）上的事件不再被消费——cleanup 已摘旧监听
    dispatchIpc(oldWv!, 'oru:deckMeta', { width: 1, height: 1, slideCount: 1, profile: 'deck' });
    expect(useArtifactStore.getState().deckMetaByArtifact.A.width).toBe(800);
  });
});
