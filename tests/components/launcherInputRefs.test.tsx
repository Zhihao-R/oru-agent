/** @vitest-environment jsdom */
/**
 * 主页启动器输入栏的「引用」一类 composer 状态——曾整类漏接：引用已写进 per-agent 草稿桶
 * （referenceFiles.ts 用 composerKey 解析），但输入框既不渲染也不许「仅引用」发送，
 * 拖文件进来还只亮高亮不落桶。覆盖：chip 呈现与删除、仅引用可发、拖拽落桶、发送不清桶
 * （清空交给 HomeLanding 的 migrateComposerRefs + chatStore.send）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LauncherInput } from '@/components/home/LauncherInput';
import { useChatStore } from '@/stores/chatStore';
import { FILE_DRAG_MIME } from '@/lib/fileDrag';

const AGENT = 'a-ref';
const KEY = `draft:${AGENT}`;

function refs() {
  return useChatStore.getState().composerRefsByConv[KEY] ?? [];
}

function renderLauncher(onSubmit: (text: string, attachments?: unknown) => void = () => {}) {
  return render(
    <LauncherInput agentId={AGENT} oruName="Oru" disabled={false} onSubmit={onSubmit} />,
  );
}

/** 文件树/标签页拖拽源的 payload 形状（fileDrag.ts 协议） */
function fileDragTransfer(payload: object) {
  return {
    types: [FILE_DRAG_MIME],
    files: [],
    getData: (type: string) => (type === FILE_DRAG_MIME ? JSON.stringify(payload) : ''),
  };
}

beforeEach(() => {
  useChatStore.setState({
    draftTextByConv: {},
    attachmentsByConv: {},
    composerRefsByConv: {},
    loopModeByConv: {},
  });
});

afterEach(cleanup);

describe('启动器输入栏：文件引用', () => {
  it('草稿桶里的引用渲染成 chip，点 × 移除', () => {
    useChatStore.setState({
      composerRefsByConv: {
        [KEY]: [{ id: 'r1', kind: 'file', quote: 'readme.md', sourcePath: 'Oru笔记/readme.md' }],
      },
    });
    renderLauncher();

    expect(screen.getByText('readme.md')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '移除引用' }));
    expect(refs()).toHaveLength(0);
  });

  it('仅有引用、没打字也能发送，且发送不清空引用桶（留给 migrate + send）', () => {
    useChatStore.setState({
      composerRefsByConv: {
        [KEY]: [{ id: 'r1', kind: 'file', quote: 'readme.md', sourcePath: 'Oru笔记/readme.md' }],
      },
    });
    const onSubmit = vi.fn();
    renderLauncher(onSubmit);

    fireEvent.click(screen.getByRole('button', { name: /发送/ }));
    expect(onSubmit).toHaveBeenCalledWith('', undefined);
    expect(refs()).toHaveLength(1);
  });

  it('文件树拖进输入框 → 落进草稿桶（多选整组）', () => {
    const { container } = renderLauncher();
    const box = container.firstElementChild!;

    fireEvent.drop(box, {
      dataTransfer: fileDragTransfer({
        paths: ['docs/a.md', 'docs/b.csv'],
        path: 'docs/a.md',
        name: 'a.md',
      }),
    });

    expect(refs().map((r) => r.sourcePath)).toEqual(['docs/a.md', 'docs/b.csv']);
    expect(refs().every((r) => r.kind === 'file')).toBe(true);
  });
});
