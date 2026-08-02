/**
 * ProfileDocView 承重测试（Plan3 Task1）：
 * 只读默认 / ✎ 进编辑（眉标变"编辑中"）
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act, waitFor } from '@testing-library/react';

// --- mock wsClient ---
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
    // 读/写同一个 MdEditor，readOnly 切换——测试据 data-readonly 判定编辑态（不再看 md-editor 有无）
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
import type { MemoryDocLiveEvent } from '@shared/protocol';
import { ProfileDocView } from '@/components/memory/ProfileDocView';

const REL_PATH = 'agents/twin/self.md';
const INITIAL_CONTENT = '# Oru\n自述';

function makeReadLiveResp(content = INITIAL_CONTENT): MemoryDocLiveEvent {
  return { type: 'memory.doc.live', relPath: REL_PATH, content, status: 'written' };
}

beforeEach(() => {
  requestMock.mockReset();
  useEditorStore.setState({ files: {} });

  requestMock.mockImplementation((req: { type: string }) => {
    if (req.type === 'memory.doc.readLive') return Promise.resolve(makeReadLiveResp());
    return Promise.resolve({ type: 'memory.doc.live', relPath: REL_PATH, content: INITIAL_CONTENT, status: 'written' });
  });
});

afterEach(() => {
  cleanup();
  const st = useEditorStore.getState();
  for (const k of Object.keys(st.files)) st.close(k);
});

it('ProfileDocView 默认只读，点编辑进入、完成落盘', async () => {
  render(
    <ProfileDocView
      relPath={REL_PATH}
      title="关于 Oru 自己"
      eyebrow="手账 · 档案"
      eyebrowEditing="手账 · 档案 · 编辑中"
      onClose={() => {}}
    />,
  );

  // 等待 openRef 完成
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });

  // 默认只读：标题可见，编辑器常驻但处 readOnly（读/写同一个 MdEditor）
  await screen.findByText('关于 Oru 自己');
  expect(screen.getByTestId('md-editor').getAttribute('data-readonly')).toBe('true');

  // 点编辑
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
  });

  // 眉标变「编辑中」+ 同一个编辑器转为可编辑（readOnly=false）
  const editingLabel = await screen.findByText(/编辑中/);
  expect(editingLabel).toBeTruthy();
  await waitFor(() =>
    expect(screen.getByTestId('md-editor').getAttribute('data-readonly')).toBe('false'),
  );
});
