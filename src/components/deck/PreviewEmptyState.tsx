/**
 * 预览空状态：deck 还是空壳（slideCount===0）时中间区显示。
 *
 * 一张柔和的空 slide 骨架占位卡（淡底 + 几条骨架条）+ 「这里还什么都没有」+ 主 CTA。
 * CTA 与标签栏「从文稿生成演示设计」同一动作（generateDeck）。无任何阴影、全走主题 token。
 */
import { useTranslation } from 'react-i18next';

type Props = {
  /** 是否禁用 CTA（有进行中提交时）；后端并发约束会拒，前端先禁更友好 */
  disabled: boolean;
  /** 生成任务进行中态（'running' 生成中 / 'queued' 排队中）——CTA 改文案并禁用，点了按钮看得见状态 */
  busy: 'running' | 'queued' | null;
  onGenerate: () => void;
};

export function PreviewEmptyState({ disabled, busy, onGenerate }: Props) {
  const { t } = useTranslation('deck');
  return (
    <div className="flex h-full flex-col items-center justify-center bg-sunken px-8 text-center">
      {/* 空 slide 骨架卡：淡底 + 标题条（accent-soft）+ 两条灰骨架。无叠层、无阴影 */}
      <div className="mb-7 flex aspect-[16/9] w-64 flex-col justify-center gap-3 rounded-lg border border-border bg-elevated px-8">
        <div className="h-3 w-1/2 rounded bg-accent-soft" />
        <div className="h-2 w-full rounded bg-border" />
        <div className="h-2 w-2/3 rounded bg-border" />
      </div>
      <h3 className="text-sm font-medium text-text-tertiary">{t('emptyState.nothing')}</h3>
      <button
        type="button"
        onClick={onGenerate}
        disabled={disabled || busy !== null}
        className="mt-4 h-9 rounded-lg bg-accent px-5 text-sm font-medium text-accent-fg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {busy
          ? t(busy === 'running' ? 'emptyState.generating' : 'emptyState.generateQueued')
          : t('emptyState.generate')}
      </button>
    </div>
  );
}
