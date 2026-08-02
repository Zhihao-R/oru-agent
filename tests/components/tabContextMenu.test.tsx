/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { TabContextMenu } from '@/components/workspace/TabContextMenu';
import { useFsStore } from '@/stores/fsStore';
import * as refMod from '@/lib/referenceFiles';

describe('TabContextMenu', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(cleanup);

  it('渲染四项,无重命名/回收站', () => {
    render(<TabContextMenu x={0} y={0} source={{ path: 'a.md', name: 'a.md' }} onClose={() => {}} />);
    expect(screen.getByText('引用到对话')).toBeTruthy();
    expect(screen.getByText('创建副本')).toBeTruthy();
    expect(screen.getByText('复制路径')).toBeTruthy();
    expect(screen.getByText('在访达中显示')).toBeTruthy();
    expect(screen.queryByText('重命名')).toBeNull();
    expect(screen.queryByText('移到回收站')).toBeNull();
  });

  it('点击「引用到对话」调 referenceFilesToComposer([path])', () => {
    const spy = vi.spyOn(refMod, 'referenceFilesToComposer').mockImplementation(() => {});
    render(<TabContextMenu x={0} y={0} source={{ path: 'docs/a.md', name: 'a.md' }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('引用到对话'));
    expect(spy).toHaveBeenCalledWith(['docs/a.md']);
  });

  it('点击「创建副本」调 fsStore.duplicate(path)', () => {
    const dup = vi.fn();
    vi.spyOn(useFsStore, 'getState').mockReturnValue({ duplicate: dup, reveal: vi.fn() } as never);
    render(<TabContextMenu x={0} y={0} source={{ path: 'docs/a.md', name: 'a.md' }} onClose={() => {}} />);
    fireEvent.click(screen.getByText('创建副本'));
    expect(dup).toHaveBeenCalledWith('docs/a.md');
  });
});
