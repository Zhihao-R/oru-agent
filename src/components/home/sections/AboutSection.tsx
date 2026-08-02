/**
 * 关于你 / 关于小知（P4/P6）——32px 头像领衔标题行（hover 出铅笔=编辑资料）
 * + mono「修订 MM·DD」（C5，档案 last-updated 到位后显示）+ 印象开头段
 * + 「展开 › / 另有 N 则小节」。全文走「关于全文」浮层。
 */
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { profileDocPreview, type ProfileDoc } from '@shared/memory/profileDoc';
import { useMemoryStore } from '@/stores/memoryStore';
import { HomeAvatar } from '../HomeAvatar';

const EMPTY: ProfileDoc = { impression: '', sections: [] };

type Props = {
  variant: 'user' | 'self';
  relPath: string;
  name: string;
  avatarPath: string | null;
  /** 档案修订日 MM·DD（C5，last-updated 透传到位后由父级传入；无则不显示徽） */
  revisionDate: string | null;
  onEditProfile: () => void;
  onExpand: () => void;
};

export function AboutSection({ variant, relPath, name, avatarPath, revisionDate, onEditProfile, onExpand }: Props) {
  const { t } = useTranslation('home');
  const doc = useMemoryStore((s) => s.docs[relPath]) ?? EMPTY;
  const fetchDoc = useMemoryStore((s) => s.fetchDoc);

  useEffect(() => {
    void fetchDoc(relPath);
  }, [relPath, fetchDoc]);

  const opening = profileDocPreview(doc);
  const heading = variant === 'user' ? t('about.you') : t('about.self', { name });

  return (
    <section>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onEditProfile}
          title={t('about.editTooltip')}
          className="group relative flex shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <HomeAvatar name={name} avatarPath={avatarPath} size={32} variant={variant === 'user' ? 'neutral' : 'accent'} />
          <span className="absolute -bottom-0.5 -right-1 flex h-[15px] w-[15px] items-center justify-center rounded-full border border-border-strong bg-elevated text-text-secondary opacity-0 transition-opacity group-hover:opacity-100">
            <PenIcon />
          </span>
        </button>
        <h2 className="m-0 font-serif text-[21px] font-semibold text-text-primary">{heading}</h2>
        {revisionDate && <span className="font-mono text-[10.5px] text-text-quaternary">{t('about.revision', { date: revisionDate })}</span>}
      </div>
      {opening && (
        <div className="mt-3 space-y-2 text-[14px] leading-[1.9] text-text-primary">
          {opening.split('\n').map((para, i) => (
            <p key={i} className="m-0">
              {para}
            </p>
          ))}
        </div>
      )}
      <div className="mt-2.5 flex items-baseline gap-3 text-[12px]">
        <button type="button" onClick={onExpand} className="text-accent-deep">
          {t('about.expand')}
        </button>
        {doc.sections.length > 0 && (
          <span className="text-text-quaternary">{t('about.moreSections', { count: doc.sections.length })}</span>
        )}
      </div>
    </section>
  );
}

function PenIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="m11.3 2.7 2 2L5.5 12.5l-2.8.8.8-2.8z" />
    </svg>
  );
}
