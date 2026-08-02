/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { TabBar } from '@/components/workspace/TabBar';
import { useWorkspaceStore, makeTab } from '@/stores/workspaceStore';
import { FILE_DRAG_MIME } from '@/lib/fileDrag';

// jsdom 既没有 ResizeObserver 也不排版（clientWidth 恒 0）——两者都替掉，才能驱动宽度分配。
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverStub);

function stubBarWidth(px: number): void {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => px });
}

/** 栏里（非菜单里）的标签，按渲染顺序。 */
function barTabs(): HTMLElement[] {
  return screen.getAllByRole('tab');
}

describe('TabBar 交互', () => {
  beforeEach(() => {
    stubBarWidth(900);
    const tab = makeTab({ kind: 'editor', projectId: 'p1', ref: 'docs/a.md', title: 'a.md' });
    useWorkspaceStore.setState({ openTabs: [tab], activeTabId: tab.id });
  });
  afterEach(cleanup);

  it('右键标签弹出菜单（含引用到对话）', () => {
    render(<TabBar />);
    fireEvent.contextMenu(screen.getByText('a.md'));
    expect(screen.getByText('引用到对话')).toBeTruthy();
  });

  it('拖拽标签往 dataTransfer 写文件引用 payload', () => {
    render(<TabBar />);
    const setData = vi.fn();
    const tab = screen.getByText('a.md').closest('[role="tab"]')!;
    fireEvent.dragStart(tab, {
      dataTransfer: { setData, getData: () => '', effectAllowed: '' },
    });
    expect(setData).toHaveBeenCalledWith(
      FILE_DRAG_MIME,
      JSON.stringify({ paths: ['docs/a.md'], path: 'docs/a.md', name: 'a.md' }),
    );
  });

  it('关闭 ✕ 不占位：绝对定位覆盖 + hover 才现身', () => {
    render(<TabBar />);
    const close = screen.getByRole('button', { name: /关闭/ });
    expect(close.className).toContain('absolute'); // 占位的话名字预算要少 18px，压缩档吃掉近四成
    expect(close.className).toContain('invisible');
    expect(close.className).toContain('group-hover:visible');
  });

  it('文件名中间省略：尾部辨识位保留在标签里', () => {
    const tab = makeTab({
      kind: 'image',
      projectId: 'p1',
      ref: 'assets/mountain-gradient-1.png',
      title: 'mountain-gradient-1.png',
    });
    useWorkspaceStore.setState({ openTabs: [tab], activeTabId: tab.id });
    render(<TabBar />);
    // 断"尾段独立成节点且不参与 truncate"——只断 textContent 含 -1.png 的话，旧的整段 truncate 实现
    // 同样通过（掐尾是 CSS 干的，全名一直在 DOM 里），区分不出改动前后。
    const spans = [...barTabs()[0].querySelectorAll('span')];
    const tail = spans[spans.length - 1];
    expect(tail.textContent).toBe('t-1.png'); // 末 TAIL_CHARS 个字符，含唯一辨识位
    expect(tail.className).not.toContain('truncate');
    expect(spans.some((s) => s.className.includes('truncate') && s.textContent === 'mountain-gradien')).toBe(true);
  });
});

describe('TabBar 溢出', () => {
  /** n 个同前缀图片标签，末两个是不同目录下的同名文件（验菜单里靠目录消歧）。 */
  function seedTabs(n: number, activeAt = 0): void {
    const tabs = Array.from({ length: n }, (_, i) =>
      makeTab({
        kind: 'image',
        projectId: 'p1',
        ref: `assets/images/mountain-gradient-${i}.png`,
        title: `mountain-gradient-${i}.png`,
      }),
    );
    tabs.push(makeTab({ kind: 'editor', projectId: 'p1', ref: 'docs/note.md', title: 'note.md' }));
    tabs.push(makeTab({ kind: 'editor', projectId: 'p1', ref: 'plans/note.md', title: 'note.md' }));
    useWorkspaceStore.setState({ openTabs: tabs, activeTabId: tabs[activeAt].id });
  }

  beforeEach(() => stubBarWidth(900));
  afterEach(cleanup);

  it('放得下时不出溢出按钮', () => {
    seedTabs(1);
    render(<TabBar />);
    expect(barTabs()).toHaveLength(3);
    expect(screen.queryByRole('button', { name: /另有/ })).toBeNull();
  });

  it('放不下时多余的进溢出按钮，栏里加菜单里正好是全集', () => {
    seedTabs(18); // 20 个标签 / 900px
    render(<TabBar />);
    const btn = screen.getByRole('button', { name: /另有/ });
    const hidden = Number(btn.textContent!.match(/\d+/)![0]);
    expect(barTabs().length + hidden).toBe(20);
    expect(hidden).toBeGreaterThan(0);
  });

  it('溢出菜单里名字写全，且目录只在重名时才补', () => {
    seedTabs(18);
    render(<TabBar />);
    fireEvent.click(screen.getByRole('button', { name: /另有/ }));
    const menu = screen.getByRole('menu');
    const items = within(menu).getAllByRole('menuitem');
    // 菜单宽度够，名字整条读得出（栏里同一个名字被压成头尾两段）
    expect(items.some((el) => el.textContent === 'mountain-gradient-17.png')).toBe(true);
    // 两个 note.md 重名 → 各自补上目录；不重名的图片批次不补，不白占一行
    expect(items.filter((el) => el.textContent?.startsWith('note.md'))).toHaveLength(2);
    expect(within(menu).getByText('docs')).toBeTruthy();
    expect(within(menu).getByText('plans')).toBeTruthy();
    expect(within(menu).queryByText('assets/images')).toBeNull();
  });

  it('点菜单里的标签→激活的正是点的那个，并且它随即出现在栏里', () => {
    seedTabs(18);
    render(<TabBar />);
    fireEvent.click(screen.getByRole('button', { name: /另有/ }));
    const first = within(screen.getByRole('menu')).getAllByRole('menuitem')[0];
    const picked = first.textContent!; // 该行不重名，没有目录层，textContent 即文件名
    fireEvent.click(first);
    const { openTabs, activeTabId } = useWorkspaceStore.getState();
    expect(openTabs.find((tb) => tb.id === activeTabId)!.title).toBe(picked);
    const inBar = barTabs().find((el) => el.getAttribute('aria-selected') === 'true')!;
    expect(inBar.textContent).toBe(picked); // 中间省略只拆节点不丢字符
  });

  it('活跃标签落在溢出区时被提进栏里，永不消失', () => {
    seedTabs(18, 19); // 活跃 = 最后一个 note.md
    render(<TabBar />);
    const activeInBar = barTabs().find((el) => el.getAttribute('aria-selected') === 'true');
    expect(activeInBar).toBeTruthy();
    expect(activeInBar!.textContent).toContain('note.md');
  });

  it('从菜单里关标签：标签消失，菜单留着好接着关下一个', () => {
    seedTabs(18);
    render(<TabBar />);
    fireEvent.click(screen.getByRole('button', { name: /另有/ }));
    const menu = screen.getByRole('menu');
    const before = within(menu).getAllByRole('menuitem').length;
    fireEvent.click(within(menu.querySelectorAll('[role="menuitem"]')[0]!.parentElement!).getByRole('button', { name: /关闭/ }));
    expect(useWorkspaceStore.getState().openTabs).toHaveLength(19);
    expect(within(screen.getByRole('menu')).getAllByRole('menuitem')).toHaveLength(before - 1);
  });
});
