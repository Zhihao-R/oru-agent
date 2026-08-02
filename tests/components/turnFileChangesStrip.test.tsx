/**
 * 回合级「本轮文件变更」条（2026-07-20 方案 B；2026-07-28 PRD 第 7 项·决策二扩展）。
 *
 * 规则：一条 assistant 消息内的文件变更标记（structured.fileChanges / 遗留 file）按
 * 「项目+相对路径」聚合去重；四种操作全进、各标操作类型；删除条目不给打开入口；
 * 少量文件平铺，超过折叠阈值默认折叠；回合未定居（流式中）不出条。
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

import { ChatMessage } from '@/components/chat/ChatMessage';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import type { ChatMessage as Msg, Project, ToolCall } from '@shared/types';
import type { StructuredMarkers } from '@shared/agent/structuredMarkers';

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
  useEditorStore.setState({ open: editorOpen });
});
afterEach(cleanup);

let seq = 0;
function mkTool(name: string, structured: StructuredMarkers): ToolCall {
  seq += 1;
  return {
    id: `t${seq}`,
    name,
    input: {},
    status: 'success',
    startedAt: 1000,
    finishedAt: 1400,
    result: { toolCallId: `t${seq}`, isError: false, summary: 'ok', structured },
  };
}

function writeTool(rel: string, created: boolean): ToolCall {
  const abs = `/tmp/demo/${rel}`;
  return mkTool('write_file', { file: { path: abs, created } });
}

function msg(toolCalls: ToolCall[], done = true): Msg {
  return { id: 'm1', conversationId: 'c1', role: 'assistant', text: '', toolCalls, createdAt: 1, done };
}

describe('本轮文件变更条', () => {
  it('少量文件：标签+平铺 chip，各标操作类型', () => {
    render(
      <ChatMessage
        message={msg([
          writeTool('复盘.md', true),
          writeTool('数据.csv', false),
          mkTool('manage_files', { fileChanges: [{ path: '/tmp/demo/旧稿.md', op: 'delete' }] }),
        ])}
      />,
    );
    expect(screen.getByText('本轮文件变更')).toBeTruthy();
    expect(screen.getByText('复盘.md')).toBeTruthy();
    expect(screen.getByText('新建')).toBeTruthy();
    expect(screen.getByText('修改')).toBeTruthy();
    expect(screen.getByText('删除')).toBeTruthy();
    expect(screen.queryByText(/个文件/)).toBeNull();
    expect(screen.queryByText('展开')).toBeNull();
  });

  it('删除条目不可点（打开入口只给仍存在的文件）；可开条目照常点开', () => {
    render(
      <ChatMessage
        message={msg([
          writeTool('复盘.md', true),
          mkTool('manage_files', { fileChanges: [{ path: '/tmp/demo/旧稿.md', op: 'delete' }] }),
        ])}
      />,
    );
    expect(screen.getByText('旧稿.md').closest('button')).toBeNull();
    fireEvent.click(screen.getByText('复盘.md'));
    expect(useWorkspaceStore.getState().openTabs[0]?.id).toBe('editor:复盘.md');
  });

  it('bash 核验通过的申报与 manage_files 改名同轮呈现；改名 chip 显示新名', () => {
    render(
      <ChatMessage
        message={msg([
          mkTool('bash', { fileChanges: [{ path: '/tmp/demo/out.csv', op: 'create' }] }),
          mkTool('manage_files', {
            fileChanges: [{ path: '/tmp/demo/新名.md', op: 'rename', from: '/tmp/demo/旧名.md' }],
          }),
        ])}
      />,
    );
    expect(screen.getByText('out.csv')).toBeTruthy();
    expect(screen.getByText('新名.md')).toBeTruthy();
    expect(screen.queryByText('旧名.md')).toBeNull();
    expect(screen.getByText('改名')).toBeTruthy();
  });

  it('超过阈值：默认折叠成计数，点「展开」平铺、再点「收起」', () => {
    const tools = Array.from({ length: 7 }, (_, i) => writeTool(`f${i}.md`, true));
    render(<ChatMessage message={msg(tools)} />);
    expect(screen.getByText('7 个文件')).toBeTruthy();
    expect(screen.queryByText('f0.md')).toBeNull();
    fireEvent.click(screen.getByText('展开'));
    expect(screen.getByText('f0.md')).toBeTruthy();
    fireEvent.click(screen.getByText('收起'));
    expect(screen.queryByText('f0.md')).toBeNull();
  });

  it('代码文件 chip 不可点（span 非 button）', () => {
    render(<ChatMessage message={msg([writeTool('src/App.tsx', true)])} />);
    expect(screen.getByText('App.tsx').closest('button')).toBeNull();
  });

  it('流式中（未定居）不出条；无变更标记不出条', () => {
    render(<ChatMessage message={msg([writeTool('复盘.md', true)], false)} />);
    expect(screen.queryByText('本轮文件变更')).toBeNull();
    cleanup();
    render(<ChatMessage message={msg([])} />);
    expect(screen.queryByText('本轮文件变更')).toBeNull();
  });
});
