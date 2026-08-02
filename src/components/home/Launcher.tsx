/**
 * 首屏启动器（设计稿 P8）——垂直居中：72px 头像（点击=编辑资料）+ 欢迎语（衬线 25px）
 * + 输入栏 + 「最近」对话 ×3 + 底部渐隐预览箭头（点击=吸附到手账）。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import type { PendingAttachment } from '@/lib/imageAttachments';
import { HomeAvatar } from './HomeAvatar';
import { LauncherInput, TOOLROW_H } from './LauncherInput';
import { currentGreeting } from './homeGreeting';

export type RecentChat = { id: string; title: string; onOpen: () => void };

type Props = {
  oruName: string;
  oruAvatarPath: string | null;
  recentChats: RecentChat[];
  agentId: string | null;
  disabled: boolean;
  /** 启动器高度 = 视口高 − PEEK（见 useHomeScroll）：输入栏因而居中、底部留手账预览。测得前 undefined */
  minH?: number;
  onEditProfile: () => void;
  onSnap: () => void;
  onSubmit: (text: string, attachments?: PendingAttachment[]) => void;
};

export function Launcher({
  oruName,
  oruAvatarPath,
  recentChats,
  agentId,
  disabled,
  minH,
  onEditProfile,
  onSnap,
  onSubmit,
}: Props) {
  const { t, i18n } = useTranslation('home');
  // 落到主页时取一次问候（跨页记忆见 currentGreeting）；同页停留不重算。语言在别的页切换、回来重挂即按新语言取。
  const [greeting] = useState(() => currentGreeting(t, i18n.language));
  // 零回流展开：输入框工具行涨 0→38 时，整列最底部的「反向占位」缩 38→0，两者高度和恒定 →
  // 居中永不重算 → 头像/欢迎语/输入框上边线纹丝不动。占位在最底部（而非夹在输入框与最近对话之间），
  // 使「最近对话」恒贴输入框底、随其展开一起下移，而非被 38px 空白垫开。
  const [inputExpanded, setInputExpanded] = useState(false);
  return (
    <div
      className="relative flex flex-col items-center justify-center text-center"
      // 高度贴视口（− PEEK）→ 输入栏落在视口中线附近；minH 在 layout 阶段即测得，首帧无闪
      style={{ minHeight: minH }}
    >
      <button
        type="button"
        onClick={onEditProfile}
        title={t('about.editTooltip')}
        className="mb-6 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <HomeAvatar name={oruName} avatarPath={oruAvatarPath} size={72} variant="accent" className="text-[27px]" />
      </button>
      <p className="m-0 whitespace-pre-line font-serif text-[25px] leading-[1.6] tracking-[-0.005em] text-text-primary">
        {greeting.heading}
      </p>
      {greeting.sub && (
        <p className="m-0 mt-2 max-w-[380px] text-[13.5px] leading-[1.55] text-text-tertiary">{greeting.sub}</p>
      )}
      <LauncherInput
        agentId={agentId}
        oruName={oruName}
        disabled={disabled}
        onSubmit={onSubmit}
        onExpandedChange={setInputExpanded}
      />
      {recentChats.length > 0 && (
        <div className="mt-[18px] flex flex-wrap items-center justify-center gap-5">
          <span className="text-[11.5px] text-text-quaternary">{t('launcher.recentLabel')}</span>
          {recentChats.map((rc) => (
            <button
              key={rc.id}
              type="button"
              onClick={rc.onOpen}
              className="border-b border-dotted border-border-heavy pb-px text-[12.5px] text-text-tertiary transition-colors hover:border-accent-deep hover:text-accent-deep"
            >
              {rc.title}
            </button>
          ))}
        </div>
      )}
      {/* 反向占位：与输入框工具行同一 toolRowOpen、同一 250ms ease-out——工具行涨 0→38 时它缩 38→0，
          整列高度恒定、居中不重算；收在最底部让「最近对话」贴着输入框底一起下移，全程零抖动。 */}
      <div
        aria-hidden
        className="w-full shrink-0"
        style={{ height: inputExpanded ? 0 : TOOLROW_H, transition: 'height 250ms ease-out' }}
      />
      <button
        type="button"
        onClick={onSnap}
        aria-label={t('launcher.scrollHint')}
        className="absolute bottom-[22px] left-1/2 -translate-x-1/2 text-text-quaternary transition-colors hover:text-text-secondary"
      >
        <ChevronDown size={14} strokeWidth={1.5} />
      </button>
    </div>
  );
}
