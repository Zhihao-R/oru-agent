/**
 * 工具详情浮层「在 Oru 中打开」（2026-07-20 拍板：方案 A 兜底入口）。
 *
 * 判定采信 result.structured.file（落盘事实标记）：审批被拒 / 历史消息无标记不显示；
 * 目标不在活跃项目内或不可开（代码文件等）不显示；点击 = 右栏开标签 + 关浮层。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

import { ToolCallLine } from '@/components/chat/ToolCallLine';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import type { Project, ToolCall } from '@shared/types';

const PROJECT: Project = {
  id: 'p1',
  ownerId: 'local-user',
  name: '演示项目',
  path: '/tmp/demo',
  addedAt: 1,
  lastOpenedAt: 1,
  hasClaudeMd: false,
};

const editorOpen = vi.fn(async (_projectId: string, _path: string) => {});

beforeEach(() => {
  vi.clearAllMocks();
  useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
  useProjectStore.setState({ projects: [PROJECT], activeProjectId: 'p1' });
  useEditorStore.setState({ open: editorOpen as unknown as ReturnType<typeof useEditorStore.getState>['open'] });
});
afterEach(cleanup);

function writeTool(absPath: string, opts?: { structured?: boolean }): ToolCall {
  return {
    id: 't1',
    name: 'mcp__oru__write_file',
    input: { path: absPath, content: 'x' },
    status: 'success',
    startedAt: 1000,
    finishedAt: 1400,
    result: {
      toolCallId: 't1',
      isError: false,
      summary: 'ok',
      ...(opts?.structured === false ? {} : { structured: { file: { path: absPath, created: true } } }),
    },
  };
}

function openDialog(tool: ToolCall): void {
  render(<ToolCallLine tool={tool} />);
  fireEvent.click(screen.getByText('write_file'));
}

describe('工具详情浮层 · 在 Oru 中打开', () => {
  it('项目内 md 且带落盘标记：显示按钮，点击开 editor 标签并关浮层', () => {
    openDialog(writeTool('/tmp/demo/docs/复盘.md'));
    fireEvent.click(screen.getByText('在 Oru 中打开'));
    const { openTabs, activeTabId } = useWorkspaceStore.getState();
    expect(openTabs).toEqual([
      { kind: 'editor', projectId: 'p1', ref: 'docs/复盘.md', title: '复盘.md', id: 'editor:docs/复盘.md' },
    ]);
    expect(activeTabId).toBe('editor:docs/复盘.md');
    expect(editorOpen).toHaveBeenCalledWith('p1', 'docs/复盘.md');
    // 浮层关闭走 AnimatePresence 退场动画，jsdom 下不同步卸载——关闭行为不在此断言
  });

  it('无落盘标记（审批被拒 / 历史消息）：不显示按钮', () => {
    openDialog(writeTool('/tmp/demo/docs/复盘.md', { structured: false }));
    expect(screen.getByText('输入')).toBeTruthy(); // 浮层开着
    expect(screen.queryByText('在 Oru 中打开')).toBeNull();
  });

  it('代码文件（不可开类型）：不显示按钮', () => {
    openDialog(writeTool('/tmp/demo/src/App.tsx'));
    expect(screen.queryByText('在 Oru 中打开')).toBeNull();
  });

  it('目标在活跃项目外：不显示按钮', () => {
    openDialog(writeTool('/elsewhere/notes.md'));
    expect(screen.queryByText('在 Oru 中打开')).toBeNull();
  });

  it('bash 核实多文件：逐文件出打开按钮（按钮文字用文件名区分）', () => {
    const tool: ToolCall = {
      id: 't1',
      name: 'mcp__oru__bash',
      input: { command: 'python split.py' },
      status: 'success',
      startedAt: 1000,
      finishedAt: 1400,
      result: {
        toolCallId: 't1',
        isError: false,
        summary: 'ok',
        structured: {
          fileChanges: [
            { path: '/tmp/demo/北京.csv', op: 'create' },
            { path: '/tmp/demo/上海.csv', op: 'create' },
          ],
        },
      },
    };
    render(<ToolCallLine tool={tool} />);
    fireEvent.click(screen.getByText('bash'));
    expect(screen.getByText('北京.csv')).toBeTruthy();
    fireEvent.click(screen.getByText('上海.csv'));
    expect(editorOpen).not.toHaveBeenCalled(); // csv 走表格视图，不进 editor——只验按钮在且可点
    expect(useWorkspaceStore.getState().openTabs[0]?.ref).toBe('上海.csv');
  });
});
