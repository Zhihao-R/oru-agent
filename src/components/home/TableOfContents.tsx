/**
 * 左侧简约目录（设计稿）——scrollTop > 520 浮现；衬线纯文字，当前项以细横线 + 主题 accent 标记；
 * 「顶部」是第一项正式锚点：未有任何节越过判定线（即处在最顶部）时高亮，点击平滑回启动器；
 * 窗口宽度不足（<1080px）整体隐藏（已拍板 E6a）。
 * 当前节由各节相对滚动容器顶部的位置推导（取最后一个越过判定线的节）。
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/cn';

export const HOME_SECTION_IDS = ['night', 'about', 'projects', 'notes'] as const;
export type HomeSectionId = (typeof HOME_SECTION_IDS)[number];

const ACTIVE_LINE = 120; // 判定线：节顶越过容器顶下方 120px 即算「当前」
/** 锚点置顶时节顶距容器顶的偏移。goto 落点与 HomeLanding 尾部留白反推共用同一个量。 */
export const ANCHOR_TOP_OFFSET = 20;

type Props = {
  visible: boolean;
  /** 传入以触发随滚动重算 active（值本身不直接用） */
  sc: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /** 实际渲染的内容锚点（「笔记」在无昨夜记录时不渲染，故由页面按实况传入而非写死） */
  sections: readonly HomeSectionId[];
  onTop: () => void;
};

function sectionTop(id: HomeSectionId, container: HTMLElement): number | null {
  const el = document.getElementById(`home-sec-${id}`);
  if (!el) return null;
  return el.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

export function TableOfContents({ visible, sc, scrollRef, sections, onTop }: Props) {
  const { t } = useTranslation('home');
  const [active, setActive] = useState<HomeSectionId | null>(null);

  // active 在 effect 里读 DOM（layout 之后），不在渲染期读 ref/getBoundingClientRect；sc 变化驱动重算。
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    let next: HomeSectionId | null = null;
    for (const id of sections) {
      const top = sectionTop(id, container);
      if (top !== null && top <= ACTIVE_LINE) next = id;
    }
    setActive((prev) => (prev === next ? prev : next));
  }, [sc, scrollRef, sections]);

  const goto = (id: HomeSectionId) => {
    const el = document.getElementById(`home-sec-${id}`);
    const c = scrollRef.current;
    if (!el || !c) return;
    const target = c.scrollTop + (el.getBoundingClientRect().top - c.getBoundingClientRect().top) - ANCHOR_TOP_OFFSET;
    c.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  };

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        'pointer-events-none absolute left-[30px] top-1/2 hidden -translate-y-1/2 flex-col gap-[13px] transition-opacity duration-[350ms] min-[1080px]:flex',
        visible ? 'opacity-100' : 'opacity-0',
      )}
      style={{ pointerEvents: visible ? 'auto' : 'none' }}
    >
      {(['top', ...sections] as const).map((id) => {
        const selected = id === 'top' ? active === null : active === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => (id === 'top' ? onTop() : goto(id))}
            className="flex items-center gap-[9px]"
          >
            <span
              className={cn('h-px w-4 transition-colors', selected ? 'bg-accent' : 'bg-transparent')}
            />
            <span
              className={cn(
                'font-serif text-[13px] tracking-[0.02em] transition-colors',
                selected ? 'text-accent' : 'text-text-quaternary hover:text-text-secondary',
              )}
            >
              {t(`toc.${id}`)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
