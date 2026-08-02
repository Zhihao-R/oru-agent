/**
 * ProjectDetailOverlay 承重测试（Plan3 Task3）：
 * 委托 ProfileDocView，含档案正文 + 开工按钮 + 编辑态眉标变化
 *
 * 注：a3f9fd41（2026-07-22「档案预览逻辑内聚」）删掉了 readAbove 插槽——浮层从「简介 + 进展 +
 * 档案 toggle」三段式收敛成 profile.md 全文本身，list-entry.md 的 intro 不再上屏（它归首页卡片的
 * 预览）。本测试原先断言 intro 段，2026-07-28 随之改为断言正文＝profile.md 全文。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react';

// --- mock wsClient（ProfileDocView 内部调 memory.doc.readLive）---
const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: {
    request: (...args: unknown[]) => requestMock(...args),
    subscribe: () => () => {},
    onStatus: () => () => {},
    ready: () => Promise.resolve(),
    status: () => 'open' as const,
  } satisfies import('@/lib/ws').OruWsClient,
}));

// --- mock MdEditor ---
vi.mock('@/components/editor/MdEditor', () => ({
  MdEditor: ({
    value,
    onChange,
    onSave,
    readOnly,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSave?: () => void;
    docIdentity?: unknown;
    readOnly?: boolean;
  }) => (
    // 读/写同一个 MdEditor，readOnly 切换
    <textarea
      data-testid="md-editor"
      data-readonly={readOnly ? 'true' : 'false'}
      value={value}
      readOnly={readOnly}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 's') onSave?.();
      }}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { useEditorStore } from '@/stores/editorStore';
import { useMemoryStore } from '@/stores/memoryStore';
import { useProjectStore } from '@/stores/projectStore';
import type { MemoryDocLiveEvent } from '@shared/protocol';
import { ProjectDetailOverlay } from '@/components/home/overlays/ProjectDetailOverlay';

const PROJECT_ID = 'p1';
const REL_PATH = `projects/${PROJECT_ID}/profile.md`;
const PROFILE_CONTENT = '# 项目档案\n内容';

function makeReadLiveResp(content = PROFILE_CONTENT): MemoryDocLiveEvent {
  return { type: 'memory.doc.live', relPath: REL_PATH, content, status: 'written' };
}

/** 等待 openRef / readLive 完成（多轮 microtask） */
async function waitForLoad() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

beforeEach(() => {
  requestMock.mockReset();
  useEditorStore.setState({ files: {} });

  requestMock.mockImplementation((req: { type: string }) => {
    if (req.type === 'memory.doc.readLive') return Promise.resolve(makeReadLiveResp());
    return Promise.resolve({ type: 'memory.doc.live', relPath: REL_PATH, content: PROFILE_CONTENT, status: 'written' });
  });

  // 注入项目 entry（含 intro 和 lastUpdated）
  useMemoryStore.setState({
    projects: [
      {
        projectId: PROJECT_ID,
        intro: '这是项目的简介。',
        introSnippet: '这是项目的简介。',
        lastUpdated: '',
      },
    ],
  } as Partial<ReturnType<typeof useMemoryStore.getState>> as Parameters<typeof useMemoryStore.setState>[0]);

  // 注入项目 name
  useProjectStore.setState({
    projects: [
      {
        id: PROJECT_ID,
        ownerId: 'local-user',
        name: '测试项目',
        path: '/tmp/p1',
        addedAt: 0,
        lastOpenedAt: 0,
        hasClaudeMd: false,
      },
    ],
    activeProjectId: PROJECT_ID,
    loading: false,
    error: null,
  } as Partial<ReturnType<typeof useProjectStore.getState>> as Parameters<typeof useProjectStore.setState>[0]);
});

afterEach(() => {
  cleanup();
  const st = useEditorStore.getState();
  for (const k of Object.keys(st.files)) st.close(k);
});

it('ProjectDetailOverlay 渲染后：显示标题 + 档案正文 + 开工按钮', async () => {
  const onClose = vi.fn();
  const onStart = vi.fn();

  render(
    <ProjectDetailOverlay projectId={PROJECT_ID} onClose={onClose} onStart={onStart} />,
  );

  await waitForLoad();

  // 标题
  expect(screen.getByText('测试项目')).toBeTruthy();
  // 正文＝profile.md 全文（浮层的主体内容；简介归首页卡片，不在这里露出）
  expect((screen.getByTestId('md-editor') as HTMLTextAreaElement).value).toBe(PROFILE_CONTENT);
  // 开工按钮（真实 i18n 文案）
  expect(screen.getByRole('button', { name: /开工/ })).toBeTruthy();
  // 默认只读：编辑器常驻但处 readOnly（读/写同一个 MdEditor）
  expect(screen.getByTestId('md-editor').getAttribute('data-readonly')).toBe('true');
});

it('点击开工按钮 → onStart(projectId) 被调用', async () => {
  const onClose = vi.fn();
  const onStart = vi.fn();

  render(
    <ProjectDetailOverlay projectId={PROJECT_ID} onClose={onClose} onStart={onStart} />,
  );

  await waitForLoad();

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /开工/ }));
  });

  expect(onStart).toHaveBeenCalledWith(PROJECT_ID);
});

it('点击编辑图标 → 进入编辑态（eyebrowEditing 眉标出现）', async () => {
  const onClose = vi.fn();
  const onStart = vi.fn();

  render(
    <ProjectDetailOverlay projectId={PROJECT_ID} onClose={onClose} onStart={onStart} />,
  );

  await waitForLoad();

  // 默认只读眉标
  expect(screen.getByText('手账 · 项目')).toBeTruthy();

  // 点编辑
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
  });

  // 进编辑态后眉标变为 eyebrowEditing
  expect(screen.getByText('「手账 · 项目 · 编辑中」')).toBeTruthy();
  // 出现编辑器
  expect(screen.getByTestId('md-editor')).toBeTruthy();
});
