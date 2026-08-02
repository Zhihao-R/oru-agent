/** @vitest-environment jsdom */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Copy } from 'lucide-react';
import { ContextMenu } from '@/components/ui/ContextMenu';

describe('ContextMenu 壳', () => {
  it('渲染行、点击触发 onClick 并关闭', () => {
    const onClick = vi.fn();
    const onClose = vi.fn();
    render(
      <ContextMenu
        x={10}
        y={10}
        onClose={onClose}
        rows={[{ key: 'copy', label: '复制路径', icon: Copy, onClick }]}
      />,
    );
    fireEvent.click(screen.getByText('复制路径'));
    expect(onClick).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Esc 关闭', () => {
    const onClose = vi.fn();
    render(<ContextMenu x={0} y={0} onClose={onClose} rows={[]} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('渲染分隔符', () => {
    render(<ContextMenu x={0} y={0} onClose={() => {}} rows={[{ key: 's', separator: true }]} />);
    expect(screen.getByRole('separator')).toBeTruthy();
  });
});
