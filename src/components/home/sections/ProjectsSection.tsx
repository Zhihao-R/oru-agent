/**
 * 正在做的（P3/P7）——全量行式：项目名 + 一句进展 + 最近活动时间；hover 底色 + 行尾 ›；
 * 点行开项目详情浮层。空态：虚线引导框「+ 添加项目」就地提供。
 *
 * 一句进展取 profile.md「当前进度」段首句（dream 每晚重写，天然是进展语义），空时回落 list-entry
 * introSnippet（已拍板 E9：项目数据结构不改）。
 */
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import type { ProjectListEntry, MemoryProjectProfile } from '@shared/types';
import { useProjectStore } from '@/stores/projectStore';
import { monthDayParts } from '../homeDate';

/**
 * 「当前进度」段首句：取首个正文行，去掉 markdown bullet / checkbox 前缀。
 * 跳过标题行与 `last-updated-by-dream:` 系统哨兵（dream 复盘时间戳，非进展本身）——
 * 空壳进度段（只有标题+哨兵）由此回落到项目简介。
 */
function progressLead(progress: string | undefined): string {
  if (!progress) return '';
  const line = progress
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#') && !l.startsWith('last-updated-by-dream:'));
  if (!line) return '';
  return line.replace(/^[-*]\s*(\[[ xX]\]\s*)?/, '').trim();
}

/** lastUpdated（ISO / YYYY-MM-DD）→ 「M 月 D 日」；空则不显示。 */
function activityLabel(iso: string, monthDay: (m: number, d: number) => string): string {
  const p = monthDayParts(iso);
  return p ? monthDay(Number(p[0]), Number(p[1])) : '';
}

type Props = {
  projects: ProjectListEntry[];
  profileByPid: Record<string, MemoryProjectProfile>;
  onOpenProject: (projectId: string) => void;
  onAddProject: () => void;
};

export function ProjectsSection({ projects, profileByPid, onOpenProject, onAddProject }: Props) {
  const { t } = useTranslation('home');

  return (
    <section>
      <h2 className="m-0 font-serif text-[21px] font-semibold text-text-primary">{t('projects.heading')}</h2>
      {projects.length === 0 ? (
        <button
          type="button"
          onClick={onAddProject}
          className="mt-2.5 block w-full rounded-sm border border-dashed border-border-strong px-4 py-4 text-left text-[13px] text-text-tertiary transition-colors hover:border-border-heavy hover:text-text-secondary"
        >
          {t('projects.emptyAdd')}
        </button>
      ) : (
        <div className="mt-2.5 flex flex-col gap-0.5">
          {projects.map((p) => (
            <ProjectRow
              key={p.projectId}
              project={p}
              lead={progressLead(profileByPid[p.projectId]?.progress) || p.introSnippet || p.intro}
              time={activityLabel(p.lastUpdated, (m, d) => t('memory:colophonDate', { month: m, day: d }))}
              onOpen={() => onOpenProject(p.projectId)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function ProjectRow({
  project,
  lead,
  time,
  onOpen,
}: {
  project: ProjectListEntry;
  lead: string;
  time: string;
  onOpen: () => void;
}) {
  const name = useProjectStore(
    (s) => s.projects.find((pr) => pr.id === project.projectId)?.name ?? project.projectId,
  );
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group -mx-3 flex h-11 items-center gap-3 rounded px-3 text-left transition-colors hover:bg-sunken-2"
    >
      <span className="shrink-0 text-[14px] font-medium text-text-primary">{name}</span>
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-text-tertiary">{lead}</span>
      {time && <span className="shrink-0 font-mono text-[11px] text-text-quaternary">{time}</span>}
      <ChevronRight
        size={12}
        strokeWidth={1.5}
        className="shrink-0 text-text-quaternary opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}
