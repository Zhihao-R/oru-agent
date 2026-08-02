/**
 * 关于全文浮层（A5）——眉标「手账 · 档案」；整体自由 md 只读 ↔ 内嵌 MdEditor 就地编辑；
 * 全 icon 圆形工具条（✎/⏱ 只读态；← / ✓ 编辑态）；完成/取消语义；accent 边编辑仪式。
 * user/self 共用（HomeLanding 两处调用，Plan3 仅需验证 self 行为）。
 * 薄壳：逻辑全委托 ProfileDocView。
 */
import { useTranslation } from 'react-i18next';
import type { ReactNode } from 'react';
import { ProfileDocView } from '@/components/memory/ProfileDocView';

type Props = {
  variant: 'user' | 'self';
  relPath: string;
  name: string;
  revisionDate: string | null;
  onClose: () => void;
};

export function AboutFullOverlay({ variant, relPath, name, revisionDate, onClose }: Props) {
  const { t } = useTranslation('home');
  const title = variant === 'user' ? t('about.you') : t('about.self', { name });
  return (
    <ProfileDocView
      relPath={relPath}
      title={title}
      eyebrow={t('aboutFull.eyebrow')}
      eyebrowEditing={t('aboutFull.eyebrowEditing')}
      onClose={onClose}
      footer={
        <span className="text-[12px] text-text-quaternary">
          {t('aboutFull.lastRevised', { name, date: revisionDate ?? '—' })}
        </span>
      }
    />
  );
}
