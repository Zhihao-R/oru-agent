// @vitest-environment jsdom

/**
 * workspaceStore —— 右栏多标签工作区的单一真源（tech design §2.2 / §5.1）。
 * 覆盖：openTab 去重、activateTab、closeTab 邻接切换、relocateTab 跟随。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkspaceStore, makeTab, registerActiveTabListener, type Tab } from '@/stores/workspaceStore';

function img(ref: string): Tab {
  return makeTab({ kind: 'image', projectId: 'p1', ref, title: ref.split('/').pop() ?? ref });
}

function deck(ref: string): Tab {
  return makeTab({ kind: 'deck', projectId: 'p1', ref, title: ref });
}

describe('workspaceStore', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
  });

  it('openTab 新标签：push 到末尾并激活', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.openTab(img('b.png'));
    const s = useWorkspaceStore.getState();
    expect(s.openTabs.map((t) => t.ref)).toEqual(['a.png', 'b.png']);
    expect(s.activeTabId).toBe('image:b.png');
  });

  it('openTab 已存在 id：不新增，仅切到它', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.openTab(img('b.png'));
    ws.openTab(img('a.png')); // 重开 a
    const s = useWorkspaceStore.getState();
    expect(s.openTabs).toHaveLength(2);
    expect(s.openTabs.map((t) => t.ref)).toEqual(['a.png', 'b.png']); // 顺序不变
    expect(s.activeTabId).toBe('image:a.png'); // 切到已有的
  });

  it('activateTab 切到指定标签', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.openTab(img('b.png'));
    ws.activateTab('image:a.png');
    expect(useWorkspaceStore.getState().activeTabId).toBe('image:a.png');
  });

  it('closeTab 关活跃标签 → 切右邻', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.openTab(img('b.png'));
    ws.openTab(img('c.png'));
    ws.activateTab('image:b.png');
    ws.closeTab('image:b.png');
    const s = useWorkspaceStore.getState();
    expect(s.openTabs.map((t) => t.ref)).toEqual(['a.png', 'c.png']);
    expect(s.activeTabId).toBe('image:c.png'); // 右邻
  });

  it('closeTab 关最右活跃标签 → 切左邻', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.openTab(img('b.png'));
    ws.activateTab('image:b.png');
    ws.closeTab('image:b.png');
    expect(useWorkspaceStore.getState().activeTabId).toBe('image:a.png'); // 左邻
  });

  it('closeTab 关到空 → activeTabId = null', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.closeTab('image:a.png');
    const s = useWorkspaceStore.getState();
    expect(s.openTabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
  });

  it('closeTab 关非活跃标签 → 活跃不变', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.openTab(img('b.png'));
    ws.activateTab('image:a.png');
    ws.closeTab('image:b.png');
    const s = useWorkspaceStore.getState();
    expect(s.activeTabId).toBe('image:a.png'); // 不动
    expect(s.openTabs.map((t) => t.ref)).toEqual(['a.png']);
  });

  it('relocateTab：对应标签 ref/title/id 跟随改名', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('old/a.png'));
    ws.activateTab('image:old/a.png');
    ws.relocateTab('old/a.png', 'new/b.png');
    const s = useWorkspaceStore.getState();
    const tab = s.openTabs[0];
    expect(tab.ref).toBe('new/b.png');
    expect(tab.title).toBe('b.png');
    expect(tab.id).toBe('image:new/b.png');
    expect(s.activeTabId).toBe('image:new/b.png'); // 活跃指针随 id 迁移
  });

  it('relocateTab：迁移目录前缀（文件在被改名目录下）', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('docs/a.png'));
    ws.relocateTab('docs', 'archive');
    expect(useWorkspaceStore.getState().openTabs[0].ref).toBe('archive/a.png');
  });

  it('relocateTab：无匹配标签时不动', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.relocateTab('x.png', 'y.png');
    expect(useWorkspaceStore.getState().openTabs[0].ref).toBe('a.png');
  });

  it('relocateTab：deck 标签按 artifactId 豁免路径改名（即便 artifactId 撞上文件路径）', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(makeTab({ kind: 'deck', projectId: 'p1', ref: 'docs', title: '演示稿' }));
    ws.relocateTab('docs', 'archive'); // 文件夹 docs 改名
    const tab = useWorkspaceStore.getState().openTabs[0];
    expect(tab.ref).toBe('docs'); // deck 不被波及
    expect(tab.title).toBe('演示稿'); // title 不被 basename 覆盖
  });

  it('closeTabsUnder：关掉目录下的文件标签，活跃切邻', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('docs/a.png'));
    ws.openTab(img('docs/b.png'));
    ws.openTab(img('other/c.png'));
    ws.activateTab('image:docs/b.png');
    ws.closeTabsUnder('docs'); // 删 docs 目录
    const s = useWorkspaceStore.getState();
    expect(s.openTabs.map((t) => t.ref)).toEqual(['other/c.png']);
    expect(s.activeTabId).toBe('image:other/c.png'); // 原活跃右侧第一个存活
  });

  it('closeTabsUnder：精确单文件删除', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.openTab(img('b.png'));
    ws.closeTabsUnder('a.png');
    expect(useWorkspaceStore.getState().openTabs.map((t) => t.ref)).toEqual(['b.png']);
  });

  it('closeTabsUnder：deck 标签按 artifactId 不被路径删除波及', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(makeTab({ kind: 'deck', projectId: 'p1', ref: 'docs', title: '演示稿' }));
    ws.openTab(img('docs/a.png'));
    ws.closeTabsUnder('docs');
    const s = useWorkspaceStore.getState();
    expect(s.openTabs.map((t) => t.id)).toEqual(['deck:docs']); // deck 留下，image 关掉
  });

  it('reset：清空所有标签', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.reset();
    const s = useWorkspaceStore.getState();
    expect(s.openTabs).toEqual([]);
    expect(s.activeTabId).toBeNull();
  });

  it('makeTab：id = kind:ref', () => {
    expect(makeTab({ kind: 'deck', projectId: 'p', ref: 'art-1', title: '演示稿' }).id).toBe('deck:art-1');
  });
});

/**
 * 活跃标签变化钩子（§B 真源方向反转的承重机制：前端活跃标签 → 推后端 activeDeckId）。
 * 按 kind 注册，活跃身份变化时对「离开的旧 kind」与「进入的新 kind」各派一次，都传新的活跃标签。
 */
describe('registerActiveTabListener', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
  });

  it('进入 deck → deck listener 收到该 deck 标签', () => {
    const spy = vi.fn();
    registerActiveTabListener('deck', spy);
    useWorkspaceStore.getState().openTab(deck('A'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]?.ref).toBe('A');
  });

  it('deck → 非 deck：deck listener 被派发，收到新的活跃标签（非 deck）', () => {
    // 派发契约：listener 收「新的活跃标签」本身（无则 null）；「非 deck → 推后端 null」的映射由
    // artifactStore 的回调做（tab?.kind==='deck' ? ref : null），不在 workspaceStore 层。
    const spy = vi.fn();
    registerActiveTabListener('deck', spy);
    const ws = useWorkspaceStore.getState();
    ws.openTab(deck('A')); // 进入 deck（1 次）
    spy.mockClear();
    ws.openTab(img('x.png')); // 离开 deck → deck listener 收新活跃标签（image）
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]?.kind).toBe('image');
  });

  it('非 deck 间切换（image↔image）不触达 deck listener', () => {
    const spy = vi.fn();
    registerActiveTabListener('deck', spy);
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.openTab(img('b.png'));
    ws.activateTab('image:a.png');
    expect(spy).not.toHaveBeenCalled();
  });

  it('activateTab 切到已活跃标签：身份不变，不派发', () => {
    const spy = vi.fn();
    registerActiveTabListener('deck', spy);
    const ws = useWorkspaceStore.getState();
    ws.openTab(deck('A'));
    spy.mockClear();
    ws.activateTab('deck:A'); // 已是活跃，无变化
    expect(spy).not.toHaveBeenCalled();
  });

  it('closeTab 关最后一个 deck → deck listener 收到 null；reset 同理', () => {
    const spy = vi.fn();
    registerActiveTabListener('deck', spy);
    const ws = useWorkspaceStore.getState();
    ws.openTab(deck('A'));
    spy.mockClear();
    ws.closeTab('deck:A'); // 关到空，活跃 null
    expect(spy).toHaveBeenCalledWith(null);

    ws.openTab(deck('B'));
    spy.mockClear();
    ws.reset();
    expect(spy).toHaveBeenCalledWith(null);
  });

  it('两个不同 kind 的 listener 互不覆盖（与 registerTabCloser 对称）', () => {
    const deckSpy = vi.fn();
    const imageSpy = vi.fn();
    registerActiveTabListener('deck', deckSpy);
    registerActiveTabListener('image', imageSpy);
    const ws = useWorkspaceStore.getState();
    ws.openTab(deck('A')); // deck 进入
    ws.openTab(img('x.png')); // deck 离开 + image 进入
    // deck listener：进入(1) + 离开(1) = 2 次；image listener：进入(1) = 1 次
    expect(deckSpy).toHaveBeenCalledTimes(2);
    expect(imageSpy).toHaveBeenCalledTimes(1);
  });

  it('replaceTab：同 index 替换并激活新标签（xlsx 预览原地转 CSV 的体感地基）', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('a.png'));
    ws.openTab(img('book.xlsx'));
    ws.openTab(img('c.png'));
    ws.activateTab('image:book.xlsx'); // 预览是活跃标签（原地切换语义只搬活跃指针的这种情况）
    ws.replaceTab('image:book.xlsx', makeTab({ kind: 'table', projectId: 'p1', ref: 'book.csv', title: 'book.csv' }));
    const s = useWorkspaceStore.getState();
    expect(s.openTabs.map((t) => t.id)).toEqual(['image:a.png', 'table:book.csv', 'image:c.png']); // 位置不变
    expect(s.activeTabId).toBe('table:book.csv');
  });

  it('replaceTab：目标标签已开 → 不制造重复 id，关旧标签并激活既有目标', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('book.csv 早已打开'));
    ws.openTab(makeTab({ kind: 'table', projectId: 'p1', ref: 'book.csv', title: 'book.csv' }));
    ws.openTab(img('book.xlsx'));
    ws.replaceTab('image:book.xlsx', makeTab({ kind: 'table', projectId: 'p1', ref: 'book.csv', title: 'book.csv' }));
    const s = useWorkspaceStore.getState();
    expect(s.openTabs.map((t) => t.id)).toEqual(['image:book.csv 早已打开', 'table:book.csv']); // 预览被关，无重复
    expect(s.activeTabId).toBe('table:book.csv');
  });

  it('replaceTab：旧标签非活跃时替换不动活跃指针', () => {
    const ws = useWorkspaceStore.getState();
    ws.openTab(img('book.xlsx'));
    ws.openTab(img('a.png')); // 活跃在 a.png
    ws.replaceTab('image:book.xlsx', makeTab({ kind: 'table', projectId: 'p1', ref: 'book.csv', title: 'book.csv' }));
    const s = useWorkspaceStore.getState();
    expect(s.activeTabId).toBe('image:a.png');
    expect(s.openTabs.map((t) => t.id)).toEqual(['table:book.csv', 'image:a.png']);
  });
});
