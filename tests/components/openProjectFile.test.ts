/**
 * openProjectFile：对话组件「在 Oru 中打开文件」的统一通路（与文件树 activate 同源）。
 *
 * 关注：扩展名→标签类型映射、openTab 落列、各查看器内容桶的建桶调用、
 * 不可打开类型（代码文件等）返回 false 且零副作用。
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(_payload: ClientRequestPayload): Promise<T> => {
      throw new Error('本测试不应触发 ws 请求');
    },
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { openableKind, openProjectFile } from '@/lib/openProjectFile';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useEditorStore } from '@/stores/editorStore';
import { useTableStore } from '@/stores/tableStore';
import { useHtmlAnnotStore } from '@/stores/htmlAnnotStore';
import { usePdfStore } from '@/stores/pdfStore';
import { useProjectStore } from '@/stores/projectStore';
import type { Project } from '@shared/types';

const PROJECT: Project = {
  id: 'p1',
  ownerId: 'local-user',
  name: '演示项目',
  path: '/tmp/demo',
  addedAt: 1,
  lastOpenedAt: 1,
  hasClaudeMd: false,
};

// 建桶动作替换为 spy：签名与 store 实际 action 一致（参数 projectId, path）
const editorOpen = vi.fn(async (_projectId: string, _path: string) => {});
const tableOpen = vi.fn(async (_projectId: string, _path: string) => {});
const annotActivate = vi.fn(async (_ref: string, _abs: string) => {});

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
  useProjectStore.setState({ projects: [PROJECT], activeProjectId: 'p1' });
  usePdfStore.setState({ byRef: {} });
  useEditorStore.setState({ open: editorOpen as unknown as ReturnType<typeof useEditorStore.getState>['open'] });
  useTableStore.setState({ open: tableOpen as unknown as ReturnType<typeof useTableStore.getState>['open'] });
  useHtmlAnnotStore.setState({
    activate: annotActivate as unknown as ReturnType<typeof useHtmlAnnotStore.getState>['activate'],
  });
});

describe('openableKind', () => {
  it('五类可开：md→editor / csv→table / html→html / png→image / pdf→pdf', () => {
    expect(openableKind('docs/复盘.md')).toBe('editor');
    expect(openableKind('数据.csv')).toBe('table');
    expect(openableKind('page.html')).toBe('html');
    expect(openableKind('img/图.png')).toBe('image');
    expect(openableKind('报告.pdf')).toBe('pdf');
  });

  it('代码文件 / xlsx / 无扩展名不可开', () => {
    expect(openableKind('src/App.tsx')).toBeNull();
    expect(openableKind('报表.xlsx')).toBeNull();
    expect(openableKind('Makefile')).toBeNull();
  });
});

describe('openProjectFile', () => {
  it('md：落 editor 标签并建内容桶', () => {
    expect(openProjectFile('p1', 'docs/复盘.md')).toBe(true);
    const { openTabs, activeTabId } = useWorkspaceStore.getState();
    expect(openTabs).toEqual([
      { kind: 'editor', projectId: 'p1', ref: 'docs/复盘.md', title: '复盘.md', id: 'editor:docs/复盘.md' },
    ]);
    expect(activeTabId).toBe('editor:docs/复盘.md');
    expect(editorOpen).toHaveBeenCalledWith('p1', 'docs/复盘.md');
  });

  it('csv：落 table 标签并建表格桶', () => {
    expect(openProjectFile('p1', '数据.csv')).toBe(true);
    expect(useWorkspaceStore.getState().openTabs[0].kind).toBe('table');
    expect(tableOpen).toHaveBeenCalledWith('p1', '数据.csv');
  });

  it('html：落 html 标签并以项目根拼绝对路径建标注桶', () => {
    expect(openProjectFile('p1', 'deck/page.html')).toBe(true);
    expect(useWorkspaceStore.getState().openTabs[0].kind).toBe('html');
    expect(annotActivate).toHaveBeenCalledWith('deck/page.html', '/tmp/demo/deck/page.html');
  });

  it('图片：只落标签，无桶', () => {
    expect(openProjectFile('p1', '图.png')).toBe(true);
    expect(useWorkspaceStore.getState().openTabs[0].kind).toBe('image');
    expect(editorOpen).not.toHaveBeenCalled();
    expect(tableOpen).not.toHaveBeenCalled();
  });

  it('pdf：落 pdf 标签并以项目根拼绝对路径建视图态桶', () => {
    expect(openProjectFile('p1', '报告.pdf')).toBe(true);
    expect(useWorkspaceStore.getState().openTabs[0].kind).toBe('pdf');
    expect(usePdfStore.getState().byRef['报告.pdf']?.absPath).toBe('/tmp/demo/报告.pdf');
  });

  it('不可开类型：返回 false 且不落标签', () => {
    expect(openProjectFile('p1', 'src/App.tsx')).toBe(false);
    expect(useWorkspaceStore.getState().openTabs).toEqual([]);
  });

  it('已开同文件：切过去不重复开（openTab 幂等语义透传）', () => {
    openProjectFile('p1', 'docs/复盘.md');
    openProjectFile('p1', 'docs/复盘.md');
    expect(useWorkspaceStore.getState().openTabs).toHaveLength(1);
  });
});
