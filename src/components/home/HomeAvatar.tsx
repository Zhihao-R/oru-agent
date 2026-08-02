/**
 * 主页首字母头像——有图显图（圆形蒙版），无图显名字首字（设计稿的 辰 / 知 圆）。
 * variant：accent = teal 淡底（Oru 侧），neutral = 下沉底（用户侧）。
 * 尺寸与字号跟随 size；边框按设计稿走 border-strong。
 */
import { cn } from '@/lib/cn';

type Props = {
  name: string;
  avatarPath: string | null;
  size: number;
  variant: 'accent' | 'neutral';
  className?: string;
};

export function HomeAvatar({ name, avatarPath, size, variant, className }: Props) {
  const fontSize = Math.round(size * 0.4);
  const char = [...(name || '')][0] ?? '';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-border-strong',
        variant === 'accent' ? 'bg-accent-soft text-accent-deep' : 'bg-sunken text-text-secondary',
        className,
      )}
      style={{ width: size, height: size }}
    >
      {avatarPath ? (
        <img
          src={`oru-avatar://local${encodeURI(avatarPath)}`}
          alt=""
          draggable={false}
          className="h-full w-full object-cover"
        />
      ) : (
        <span className="font-serif font-medium leading-none" style={{ fontSize }}>
          {char}
        </span>
      )}
    </span>
  );
}
