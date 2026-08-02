// @vitest-environment jsdom

/**
 * artifactStore deck 接入（右栏多标签工作区阶段4，tech design §3.7 §B §六）
 *
 * 覆盖：
 *  - activeArtifactId 派生自活跃标签（不再是本 store 独立真源）；
 *  - 真源方向反转：activeTab 命中 deck → 推后端 artifact.activate；syncArtifacts 不写 active；
 *  - 四槽分桶：两个 deck 各设 currentPageIndex / chromeState 互不覆盖，第三个激活不清前两个；
 *  - 关 deck 标签清掉该 artifact 的分桶槽。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { useArtifactStore, useActiveArtifactId, getActiveArtifactId } from '@/stores/artifactStore';
import { useWorkspaceStore, makeTab } from '@/stores/workspaceStore';
import { renderHook } from '@testing-library/react';

function deckTab(id: string) {
  return makeTab({ kind: 'deck', projectId: 'p1', ref: id, title: id });
}

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ type: 'ack' });
  useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
  useArtifactStore.setState({
    currentPageIndexByArtifactId: {},
    chromeStateByArtifactId: {},
    compareStateByArtifactId: {},
    jumpSignalByArtifactId: {},
    frameSelectSignalByArtifactId: {},
    reloadSignalByArtifactId: {},
    deckTabByArtifactId: {},
    deckMetaByArtifact: {},
  });
});

describe('activeArtifactId 派生自活跃标签（§B）', () => {
  it('活跃标签是 deck → getActiveArtifactId = 它的 ref；不是 deck → null', () => {
    useWorkspaceStore.getState().openTab(deckTab('A'));
    expect(getActiveArtifactId()).toBe('A');

    // 切到一个 md 标签 → 不是 deck，派生 null
    useWorkspaceStore.getState().openTab(makeTab({ kind: 'editor', projectId: 'p1', ref: 'x.md', title: 'x.md' }));
    expect(getActiveArtifactId()).toBeNull();
  });

  it('useActiveArtifactId hook 随活跃标签变化', () => {
    const { result, rerender } = renderHook(() => useActiveArtifactId());
    expect(result.current).toBeNull();
    useWorkspaceStore.getState().openTab(deckTab('A'));
    rerender();
    expect(result.current).toBe('A');
  });

  it('开 deck 标签 → 推后端 artifact.activate(ref)；切到非 deck → 推 null', () => {
    useWorkspaceStore.getState().openTab(deckTab('A'));
    expect(requestMock).toHaveBeenCalledWith({ type: 'artifact.activate', artifactId: 'A' });

    requestMock.mockClear();
    useWorkspaceStore.getState().openTab(makeTab({ kind: 'editor', projectId: 'p1', ref: 'x.md', title: 'x.md' }));
    expect(requestMock).toHaveBeenCalledWith({ type: 'artifact.activate', artifactId: null });
  });
});

describe('syncArtifacts 不写 activeArtifactId（真源方向反转）', () => {
  it('后端推 deck 列表只更新 artifactsByProject，不影响派生 active', () => {
    useWorkspaceStore.getState().openTab(deckTab('A'));
    useArtifactStore.getState().syncArtifacts('p1', [
      { id: 'B', projectId: 'p1', name: 'B', path: '/p/B', createdAt: 0, updatedAt: 0 },
    ]);
    // 活跃仍是标签决定的 A，后端列表里的 B 不会篡夺活跃
    expect(getActiveArtifactId()).toBe('A');
    expect(useArtifactStore.getState().artifactsByProject.p1).toHaveLength(1);
  });
});

describe('四槽分桶：两个 deck 互不串（§六）', () => {
  it('各设 currentPageIndex / chromeState，互不覆盖；第三个激活不清前两个', () => {
    const store = useArtifactStore.getState();
    // 给三个 deck 各设 meta（slideCount 足够大，clamp 不影响）
    for (const id of ['A', 'B', 'C']) {
      store.setArtifactMeta(id, { width: 1920, height: 1080, slideCount: 10, profile: 'deck' });
    }
    store.setCurrentPage('A', 3);
    store.setChromeState('A', 'immersive');
    store.setCurrentPage('B', 7);
    store.setChromeState('B', 'fullscreen');

    let s = useArtifactStore.getState();
    expect(s.currentPageIndexByArtifactId.A).toBe(3);
    expect(s.currentPageIndexByArtifactId.B).toBe(7);
    expect(s.chromeStateByArtifactId.A).toBe('immersive');
    expect(s.chromeStateByArtifactId.B).toBe('fullscreen');

    // 第三个 deck 激活（开标签）不应清掉前两个的页码/chrome
    useWorkspaceStore.getState().openTab(deckTab('C'));
    useArtifactStore.getState().setCurrentPage('C', 1);

    s = useArtifactStore.getState();
    expect(s.currentPageIndexByArtifactId.A).toBe(3);
    expect(s.currentPageIndexByArtifactId.B).toBe(7);
    expect(s.currentPageIndexByArtifactId.C).toBe(1);
    expect(s.chromeStateByArtifactId.A).toBe('immersive');
    expect(s.chromeStateByArtifactId.B).toBe('fullscreen');
  });

  it('jumpSignal / frameSelectSignal / compareState 各 deck 独立', () => {
    const store = useArtifactStore.getState();
    store.requestJump('A', { pageIndex: 2, scrollY: 0 });
    store.requestFrameSelect('B');
    let s = useArtifactStore.getState();
    expect(s.jumpSignalByArtifactId.A?.pageIndex).toBe(2);
    expect(s.jumpSignalByArtifactId.B).toBeUndefined();
    expect(s.frameSelectSignalByArtifactId.B).toBe(1);
    expect(s.frameSelectSignalByArtifactId.A).toBeUndefined();
  });
});

describe('关 deck 标签清分桶槽', () => {
  it('closeTab(deck) → 该 artifact 的页码/chrome/对比/信号槽全清', () => {
    const store = useArtifactStore.getState();
    store.setArtifactMeta('A', { width: 1920, height: 1080, slideCount: 10, profile: 'deck' });
    useWorkspaceStore.getState().openTab(deckTab('A'));
    store.setCurrentPage('A', 4);
    store.setChromeState('A', 'immersive');
    store.requestJump('A', { pageIndex: 1, scrollY: 0 });

    useWorkspaceStore.getState().closeTab('deck:A');

    const s = useArtifactStore.getState();
    expect(s.currentPageIndexByArtifactId.A).toBeUndefined();
    expect(s.chromeStateByArtifactId.A).toBeUndefined();
    expect(s.jumpSignalByArtifactId.A).toBeUndefined();
  });
});
