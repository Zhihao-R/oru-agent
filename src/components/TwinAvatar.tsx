/**
 * Twin 视觉锚组件——Oru 的脸。图片加载与首字母回落由通用 Avatar 原语承担，
 * 本组件只固定 fallback="O"（用户面已统一叫 Oru）并叠加工作态 spinner。
 *
 * - isWorking == true：右上角叠加旋转的赤陶色 spinner（AgentChip 用），大小跟随 size * 0.35（最小 8px）。
 */
import { Avatar } from '@/components/ui/Avatar';

type Props = {
  size: number;
  avatarPath: string | null;
  /** 工作中状态 — AgentChip 在 Twin 干活时传 true */
  isWorking?: boolean;
  className?: string;
};

export function TwinAvatar({ size, avatarPath, isWorking = false, className }: Props) {
  const loaderSize = Math.max(8, Math.round(size * 0.35));
  return (
    <Avatar size={size} avatarPath={avatarPath} fallback="O" className={className}>
      {isWorking ? (
        <span
          aria-hidden
          className="absolute -right-0.5 -top-0.5 inline-block animate-spin rounded-full border-2 border-accent border-t-transparent bg-canvas"
          style={{ width: loaderSize, height: loaderSize }}
        />
      ) : null}
    </Avatar>
  );
}
