/**
 * 正文路径 chip 化（2026-07-20 拍板）：行内 code 命中「项目内真实存在的可开文件」才升级 chip。
 *
 * 两道闸：candidateRelPath 纯判定（形状）+ fs.stat 存在性探测（事实）。
 * 不存在 / 代码文件 / 块级 code 保持普通渲染；点击 chip 在右栏开标签。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ClientRequestPayload, ServerEventPayload } from '@shared/protocol';

// fs.stat 按路径拍存在性：/tmp/demo 下的 docs/复盘.md、销售数据.csv 存在，其余不存在
const statMock = vi.fn(async (payload: ClientRequestPayload): Promise<ServerEventPayload> => {
  if (payload.type !== 'fs.stat') throw new Error(`意外请求：${payload.type}`);
  const exists = ['/tmp/demo/docs/复盘.md', '/tmp/demo/销售数据.csv'].includes(payload.filePath);
  // 服务端权威 error 回执带结构化 code（ws.ts 挂到 Error 上）；无 code = 传输失败，不落负缓存
  if (!exists) throw Object.assign(new Error('UNKNOWN: stat 失败'), { code: 'UNKNOWN' });
  return { type: 'fs.stat.result', filePath: payload.filePath, mtimeMs: 1 };
});

vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: async <T extends ServerEventPayload>(payload: ClientRequestPayload): Promise<T> =>
      (await statMock(payload)) as T,
    subscribe: () => () => {},
    ready: async () => {},
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

import { ChatMarkdown } from '@/components/chat/ChatMarkdown';
import { candidateRelPath } from '@/lib/pathChip';
import { __resetPathExistsForTest } from '@/stores/pathExistsStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useEditorStore } from '@/stores/editorStore';
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

beforeEach(() => {
  vi.clearAllMocks();
  __resetPathExistsForTest();
  useWorkspaceStore.setState({ openTabs: [], activeTabId: null });
  useProjectStore.setState({ projects: [PROJECT], activeProjectId: 'p1' });
  useEditorStore.setState({
    open: vi.fn(async () => {}) as unknown as ReturnType<typeof useEditorStore.getState>['open'],
  });
});
afterEach(cleanup);

describe('candidateRelPath（形状闸）', () => {
  it('相对路径 / 项目内绝对路径 / ./ 前缀都归一成相对', () => {
    expect(candidateRelPath('docs/复盘.md', '/tmp/demo')).toBe('docs/复盘.md');
    expect(candidateRelPath('/tmp/demo/docs/复盘.md', '/tmp/demo')).toBe('docs/复盘.md');
    expect(candidateRelPath('./销售数据.csv', '/tmp/demo')).toBe('销售数据.csv');
  });

  it('URL / 含空白 / 项目外绝对路径 / 越界 .. / 不可开扩展名都拒', () => {
    expect(candidateRelPath('https://a.com/x.md', '/tmp/demo')).toBeNull();
    expect(candidateRelPath('docs/a b.md', '/tmp/demo')).toBeNull();
    expect(candidateRelPath('/etc/passwd.md', '/tmp/demo')).toBeNull();
    expect(candidateRelPath('../secrets.md', '/tmp/demo')).toBeNull();
    expect(candidateRelPath('src/App.tsx', '/tmp/demo')).toBeNull();
  });
});

describe('正文路径 chip', () => {
  it('存在的 md：升级 chip，点击右栏开标签', async () => {
    render(<ChatMarkdown source={'报告在 `docs/复盘.md` 里。'} />);
    const chip = await screen.findByRole('button', { name: /复盘\.md/ });
    fireEvent.click(chip);
    expect(useWorkspaceStore.getState().openTabs[0]?.id).toBe('editor:docs/复盘.md');
  });

  it('不存在的路径：保持普通 code，不成按钮', async () => {
    render(<ChatMarkdown source={'还没写 `docs/不存在.md`。'} />);
    await waitFor(() => expect(statMock).toHaveBeenCalled());
    expect(screen.getByText('docs/不存在.md').closest('button')).toBeNull();
  });

  it('代码文件路径与普通行内 code：不探测、不成 chip', () => {
    render(<ChatMarkdown source={'看 `src/App.tsx` 里的 `useMemo`。'} />);
    expect(statMock).not.toHaveBeenCalled();
    expect(screen.getByText('src/App.tsx').closest('button')).toBeNull();
    expect(screen.getByText('useMemo').closest('button')).toBeNull();
  });

  it('块级 code 里的路径：不碰', () => {
    render(<ChatMarkdown source={'```\ndocs/复盘.md\n```'} />);
    expect(statMock).not.toHaveBeenCalled();
    expect(screen.getByText(/docs\/复盘\.md/).closest('button')).toBeNull();
  });
});
