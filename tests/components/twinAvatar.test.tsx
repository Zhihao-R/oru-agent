/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TwinAvatar } from '@/components/TwinAvatar';

afterEach(() => cleanup());

describe('TwinAvatar', () => {
  it('avatarPath 为 null 时渲染衬线 "O"（Oru 的脸；主对话改造后 T→O）', () => {
    render(<TwinAvatar size={24} avatarPath={null} />);
    expect(screen.getByText('O')).toBeTruthy();
  });

  it('avatarPath 不为 null 时渲染 img，src 用 oru-avatar:// 协议', () => {
    const { container } = render(<TwinAvatar size={24} avatarPath="/tmp/x.png" />);
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('oru-avatar://local/tmp/x.png');
  });

  it('isWorking 时叠加旋转的 spinner 角标', () => {
    const { container } = render(<TwinAvatar size={14} avatarPath={null} isWorking />);
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });

  it('isWorking false（默认）不渲染 spinner', () => {
    const { container } = render(<TwinAvatar size={14} avatarPath={null} />);
    expect(container.querySelector('.animate-spin')).toBeFalsy();
  });

  it('设置容器尺寸跟 size prop 一致', () => {
    const { container } = render(<TwinAvatar size={48} avatarPath={null} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.width).toBe('48px');
    expect(root.style.height).toBe('48px');
  });
});
