/**
 * 项目详情浮层（A5）——委托给 ProfileDocView，提供眉标/标题/开工按钮插槽。
 * 去除了进展 mono 段和「项目档案」toggle，编辑能力由 ProfileDocView 内置。
 */
import { useTranslation } from 'react-i18next';
import { useMemoryStore } from '@/stores/memoryStore';
import { useProjectStore } from '@/stores/projectStore';
import { ProfileDocView } from '@/components/memory/ProfileDocView';
import { monthDayParts } from '../homeDate';

type Props = {
  projectId: string;
  onClose: () => void;
  onStart: (projectId: string) => void;
};

export function ProjectDetailOverlay({ projectId, onClose, onStart }: Props) {
  const { t } = useTranslation('home');
  const entry = useMemoryStore((s) => s.projects.find((p) => p.projectId === projectId) ?? null);
  const name = useProjectStore((s) => s.projects.find((p) => p.id === projectId)?.name ?? projectId);

  const timeLabel = formatTime(entry?.lastUpdated ?? '', (m, d) => t('memory:colophonDate', { month: m, day: d }));

  return (
    <ProfileDocView
      relPath={`projects/${projectId}/profile.md`}
      title={name}
      eyebrow={t('projectDetail.eyebrow')}
      eyebrowEditing={t('projectDetail.eyebrowEditing')}
      eyebrowExtra={
        timeLabel ? (
          <span className="font-mono text-[10px] tracking-[0.16em] text-text-quaternary">{timeLabel}</span>
        ) : undefined
      }
      onClose={onClose}
      width={540}
      footer={
        <button
          type="button"
          onClick={() => onStart(projectId)}
          className="border-b border-accent pb-px text-[13px] font-semibold text-accent-deep"
        >
          {t('projectDetail.start')}
        </button>
      }
    />
  );
}

function formatTime(iso: string, monthDay: (m: number, d: number) => string): string {
  const p = monthDayParts(iso);
  return p ? monthDay(Number(p[0]), Number(p[1])) : '';
}
