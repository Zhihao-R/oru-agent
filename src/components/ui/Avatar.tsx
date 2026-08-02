/**
 * 通用圆形头像原语：有 avatarPath 走 oru-avatar:// 协议加载图片，否则渲染首字母字形
 * （暖米底 + 衬线，与 --avatar-default-bg 主题一致）。
 *
 * TwinAvatar（"O"）与评论用户头像复用本组件（image-or-首字母）。AvatarPair 因是 CSS planet
 * 双人卡、DOM/动画不同，不套本组件的渲染，但复用导出的 initialOf——纯函数收口一处、行为一致。
 *
 * 首字母取 Array.from(name)[0]：按码点取，emoji / 生僻字名字不会被 charAt 截半个代理对。
 */
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/** 无头像时的回落首字母：取 name 首个码点大写；name 空则用 fallback。 */
export function initialOf(name: string | undefined, fallback: string): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return fallback;
  return (Array.from(trimmed)[0] ?? fallback).toUpperCase();
}

export function Avatar({
  size,
  avatarPath,
  name,
  fallback,
  children,
  className,
}: {
  size: number;
  avatarPath: string | null;
  /** 无头像时取其首字母；为空则退到 fallback */
  name?: string;
  /** name 为空时的兜底字形（如 Oru 的 "O"、用户的 "你"） */
  fallback: string;
  /** 叠加层（如工作态 spinner），定位由 caller 负责 */
  children?: ReactNode;
  className?: string;
}) {
  const fontSize = Math.round(size * 0.5);
  return (
    <div
      className={cn('relative inline-flex shrink-0', className)}
      style={{ width: size, height: size }}
    >
      <div
        className="flex h-full w-full items-center justify-center overflow-hidden rounded-full"
        style={{ background: 'var(--avatar-default-bg)' }}
      >
        {avatarPath ? (
          <img
            src={`oru-avatar://local${encodeURI(avatarPath)}`}
            alt=""
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <span
            className="font-serif font-semibold leading-none text-text-primary"
            style={{ fontSize }}
          >
            {initialOf(name, fallback)}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}
