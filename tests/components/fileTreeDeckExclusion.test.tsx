/** @vitest-environment jsdom */
/**
 * deck 与文件标签平级共存（右栏多标签工作区阶段4，§3.9 去粘滞移除）
 *
 * 阶段4 起 deck 是右栏标签的平级一员：双击 md/html 开成标签，不再退出 / 互斥 deck 标签。
 * 旧「双击文件退出 deck」的互斥契约整块移除——本测试反向守护：开文件标签不关掉已开的 deck 标签
 *（二者共存于 openTabs）。后端 activeDeckId 因活跃标签转成非 deck 而归零属正确同步，不在守护范围。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';
import type { FileNode, Project } from '@shared/types';

const ws = vi.hoisted(() => ({
  calls: [] as ClientRequestPayload[],
}));
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> => {
      ws.calls.push(payload);
      if (payload.type === 'fs.list') {
        return {
          type: 'fs.list.result',
          projectId: payload.projectId,
          path: payload.path,
          entries: ROOT_ENTRIES,
        } as unknown as T;
      }
      return { type: 'ack' } as unknown as T;
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { FileTree } from '@/components/FileTree';
import { useFsStore } from '@/stores/fsStore';
import { useWorkspaceStore, makeTab } from '@/stores/workspaceStore';

const HTML_NODE: FileNode = { name: 'index.html', path: 'index.html', isDirectory: false };
const MD_NODE: FileNode = { name: 'notes.md', path: 'notes.md', isDirectory: false };
const ROOT_ENTRIES: FileNode[] = [HTML_NODE, MD_NODE];

function project(): Project {
  return {
    id: 'p1',
    ownerId: 'local-user',
    name: 'proj',
    path: '/abs/proj',
    addedAt: 1000,
    lastOpenedAt: 1000,
    hasClaudeMd: false,
  };
}

describe('deck 与文件标签平级共存（去粘滞移除）', () => {
  beforeEach(() => {
    ws.calls.length = 0;
    useFsStore.getState().reset?.();
    useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
    useFsStore.getState().reset();
  });

  it('双击 md → 开成 md 标签且 deck 标签仍在（不互斥）', async () => {
    render(<FileTree projectId="p1" />);
    // 等树就位后再开 deck 标签——FileTree 挂载时的 projectId 副作用会 reset 工作区，先 render 再开避免被清
    const row = await screen.findByText('notes.md');
    useWorkspaceStore.getState().openTab(makeTab({ kind: 'deck', projectId: 'p1', ref: 'deck-1', title: 'deck-1' }));
    fireEvent.doubleClick(row);

    const tabs = useWorkspaceStore.getState().openTabs;
    // deck 标签仍在，md 标签新开，二者共存
    expect(tabs.some((t) => t.kind === 'deck' && t.ref === 'deck-1')).toBe(true);
    expect(tabs.some((t) => t.kind === 'editor' && t.ref === 'notes.md')).toBe(true);
    // 活跃切到新开的 md（deck 标签让位但未关闭）
    expect(useWorkspaceStore.getState().activeTabId).toBe('editor:notes.md');
  });
});

/**
 * 跨页导航不丢标签（PRD §6/§7 回归）：侧栏在非对话页会卸载，切到主页再回对话让 FileTree 重挂载——
 * 重挂载不能清工作区（只有「项目真正切换」才清）。
 */
describe('工作区清场只在项目切换、不在重挂载（跨页回归）', () => {
  beforeEach(() => {
    ws.calls.length = 0;
    useFsStore.getState().reset?.();
    useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
    useFsStore.getState().reset();
  });

  it('同项目重挂载（跨页返回）保留标签', async () => {
    const { unmount } = render(<FileTree projectId="p1" />);
    await screen.findByText('notes.md');
    useWorkspaceStore.getState().openTab(makeTab({ kind: 'editor', projectId: 'p1', ref: 'notes.md', title: 'notes.md' }));
    expect(useWorkspaceStore.getState().openTabs).toHaveLength(1);

    unmount(); // 切到主页：侧栏卸载
    render(<FileTree projectId="p1" />); // 切回对话：同项目重挂载
    await screen.findByText('notes.md');
    expect(useWorkspaceStore.getState().openTabs).toHaveLength(1); // 标签仍在（旧实现会被 mount 清掉）
  });

  it('项目切换清空标签', async () => {
    const { rerender } = render(<FileTree projectId="p1" />);
    await screen.findByText('notes.md');
    useWorkspaceStore.getState().openTab(makeTab({ kind: 'editor', projectId: 'p1', ref: 'notes.md', title: 'notes.md' }));
    expect(useWorkspaceStore.getState().openTabs).toHaveLength(1);

    rerender(<FileTree projectId="p2" />); // 真正切项目
    expect(useWorkspaceStore.getState().openTabs).toHaveLength(0); // 清场
  });
});
