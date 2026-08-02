/**
 * AboutFullOverlay 承重测试（Task 5）：
 * 只读默认 / ✎ 进编辑 / 完成留版 / 取消整篇回退 / × 与遮罩=完成
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act } from '@testing-library/react';

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
// onSave、docIdentity 列出以确保 AboutFullOverlay 传值不被静默忽略（MdEditorProps 未导出，故手写关键字段）
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
    // 读/写同一个 MdEditor，readOnly 切换——测试据 data-readonly 判定编辑态
    <textarea
      data-testid="md-editor"
      data-readonly={readOnly ? 'true' : 'false'}
      value={value}
      readOnly={readOnly}
      onKeyDown={(e) => {
        // 模拟 ⌘S 触发 onSave
        if ((e.metaKey || e.ctrlKey) && e.key === 's') onSave?.();
      }}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));

import { useEditorStore, refKey } from '@/stores/editorStore';
import type { MemoryDocLiveEvent } from '@shared/protocol';
import { AboutFullOverlay } from '@/components/home/overlays/AboutFullOverlay';

const REL_PATH = 'user/profile.md';
const INITIAL_CONTENT = '# 关于你\n正文';
const EDITED_CONTENT = '# 改了\n新内容';

function makeReadLiveResp(content = INITIAL_CONTENT): MemoryDocLiveEvent {
  return { type: 'memory.doc.live', relPath: REL_PATH, content, status: 'written' };
}

function makeWriteLiveResp(content = INITIAL_CONTENT): MemoryDocLiveEvent {
  return { type: 'memory.doc.live', relPath: REL_PATH, content, status: 'written' };
}

function setup() {
  const onClose = vi.fn();
  const result = render(
    <AboutFullOverlay
      variant="user"
      relPath={REL_PATH}
      name="测试用户"
      revisionDate="2026-07-21"
      onClose={onClose}
    />,
  );
  return { ...result, onClose };
}

/** 等组件的 openRef 完成（多轮 microtask） */
async function waitForLoad() {
  await act(async () => {
    // 多轮 microtask：openRef → request(readLive) → resolve → store.patchFile → React update
    await new Promise((r) => setTimeout(r, 50));
  });
}

beforeEach(() => {
  requestMock.mockReset();
  useEditorStore.setState({ files: {} });

  requestMock.mockImplementation((req: { type: string }) => {
    if (req.type === 'memory.doc.readLive') return Promise.resolve(makeReadLiveResp());
    if (req.type === 'memory.doc.writeLive') return Promise.resolve(makeWriteLiveResp());
    // manualSnapshot 调 writeDisk（mark:'manual'）→ writeLive
    return Promise.resolve({ type: 'memory.doc.live', relPath: REL_PATH, content: INITIAL_CONTENT, status: 'written' });
  });
});

afterEach(() => {
  cleanup();
  const st = useEditorStore.getState();
  for (const k of Object.keys(st.files)) st.close(k);
});

// ---- 测试 1：只读默认 ----
describe('Test 1：只读默认', () => {
  it('渲染后有眉标、标题，无 textbox/编辑器', async () => {
    setup();
    await waitForLoad();

    expect(screen.getByText('手账 · 档案')).toBeTruthy();
    expect(screen.getAllByText('关于你').length).toBeGreaterThan(0);
    expect(screen.getByTestId('md-editor').getAttribute('data-readonly')).toBe('true');
  });
});

// ---- 测试 2：✎ 进编辑 ----
describe('Test 2：✎ 进编辑', () => {
  it('点编辑按钮 → 眉标变"编辑中" + 出现 MdEditor', async () => {
    setup();
    await waitForLoad();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    });

    expect(screen.getByText('手账 · 档案 · 编辑中')).toBeTruthy();
    expect(screen.getByTestId('md-editor')).toBeTruthy();
  });
});

// ---- 测试 3：完成留版 ----
describe('Test 3：完成留版', () => {
  it('编辑改字 → 点完成 → 调了 manualSnapshot → 回只读', async () => {
    const manualSnapshotSpy = vi
      .spyOn(useEditorStore.getState(), 'manualSnapshot')
      .mockResolvedValue(undefined);

    setup();
    await waitForLoad();

    // 进编辑
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    });

    // 改内容
    const editor = screen.getByTestId('md-editor');
    await act(async () => {
      fireEvent.change(editor, { target: { value: EDITED_CONTENT } });
    });

    // 点完成
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '完成' }));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(manualSnapshotSpy).toHaveBeenCalledWith(refKey({ kind: 'memory', relPath: REL_PATH }));
    await waitFor(() => expect(screen.getByTestId('md-editor').getAttribute('data-readonly')).toBe('true'));

    manualSnapshotSpy.mockRestore();
  });

  it('无改动点完成 → 不调 manualSnapshot', async () => {
    const manualSnapshotSpy = vi
      .spyOn(useEditorStore.getState(), 'manualSnapshot')
      .mockResolvedValue(undefined);

    setup();
    await waitForLoad();

    // 进编辑（不改内容）
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    });

    // 直接点完成
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '完成' }));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(manualSnapshotSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('md-editor').getAttribute('data-readonly')).toBe('true'));

    manualSnapshotSpy.mockRestore();
  });
});

// ---- 测试 4：取消整篇回退 ----
describe('Test 4：取消整篇回退', () => {
  it('改字 → 点取消（confirm true）→ 内容回到 baseline + flush → 回只读', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const setContentSpy = vi.spyOn(useEditorStore.getState(), 'setContent');
    const flushSpy = vi
      .spyOn(useEditorStore.getState(), 'flush')
      .mockResolvedValue(undefined);

    setup();
    await waitForLoad();

    // 进编辑
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    });

    // 改内容
    const editor = screen.getByTestId('md-editor');
    await act(async () => {
      fireEvent.change(editor, { target: { value: EDITED_CONTENT } });
    });

    // 点取消
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(confirmSpy).toHaveBeenCalledWith('放弃本次修改？此次改动和版本都不保留。');

    const key = refKey({ kind: 'memory', relPath: REL_PATH });
    expect(setContentSpy).toHaveBeenCalledWith(key, INITIAL_CONTENT);
    expect(flushSpy).toHaveBeenCalledWith(key);

    await waitFor(() => expect(screen.getByTestId('md-editor').getAttribute('data-readonly')).toBe('true'));

    confirmSpy.mockRestore();
    setContentSpy.mockRestore();
    flushSpy.mockRestore();
  });
});

// ---- 测试 5：编辑态遮罩点击 = 完成后关闭 ----
// 档案 demo 定论：编辑态工具条只有 ←取消 / ✓完成，不再有 ×（× 只在只读态出现，避免破坏性丢弃
// 被误读成随手关掉）。故「编辑态触发 handleClose → done → onClose」的路径改由点遮罩承载。
describe('Test 5：编辑态遮罩点击 = 完成后关闭', () => {
  it('编辑态改字 → 点遮罩 → done() 先执行 → onClose 被调', async () => {
    const manualSnapshotSpy = vi
      .spyOn(useEditorStore.getState(), 'manualSnapshot')
      .mockResolvedValue(undefined);

    const { onClose, container } = setup();
    await waitForLoad();

    // 进编辑
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '编辑' }));
    });

    // 编辑态无 × 按钮（demo 定论）
    expect(screen.queryByRole('button', { name: '关闭' })).toBeNull();

    // 改内容
    const editor = screen.getByTestId('md-editor');
    await act(async () => {
      fireEvent.change(editor, { target: { value: EDITED_CONTENT } });
    });

    // 点遮罩（Overlay 最外层 backdrop，onClick=onClose=handleClose）
    const backdrop = container.querySelector('.absolute.inset-0') as HTMLElement;
    await act(async () => {
      fireEvent.click(backdrop);
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(manualSnapshotSpy).toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());

    manualSnapshotSpy.mockRestore();
  });

  // ---- 测试 7：variant=self 落到 self.md 路径（Plan3 Task2 验证共用组件对 self 生效）----
  it('variant=self 读写落到 agents/twin/self.md（非硬编码 user/profile.md）', async () => {
    const SELF_PATH = 'agents/twin/self.md';
    requestMock.mockImplementation((req: { type: string }) =>
      Promise.resolve({ type: 'memory.doc.live', relPath: SELF_PATH, content: '# Oru\n自述', status: 'written' }),
    );
    const onClose = vi.fn();
    render(
      <AboutFullOverlay variant="self" relPath={SELF_PATH} name="Oru" revisionDate={null} onClose={onClose} />,
    );
    await waitForLoad();
    // 打开即用 self.md 路径读，证明共用组件按传入 relPath 走、未硬编码 user profile
    expect(
      requestMock.mock.calls.some(([r]) => r.type === 'memory.doc.readLive' && r.relPath === SELF_PATH),
    ).toBe(true);
    // ✎ 进编辑仍正常（self 与 user 共用同一内核）；findByText 找不到即抛＝断言
    fireEvent.click(screen.getByRole('button', { name: /编辑/ }));
    await screen.findByText(/编辑中/);
  });
});
