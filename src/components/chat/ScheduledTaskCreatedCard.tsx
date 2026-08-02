import { useTranslation } from 'react-i18next';
import { Clock } from 'lucide-react';
import type { ToolCall } from '@shared/types';
import { normalizeToolName } from '@shared/agent/toolName';
import { readStructuredMarkers } from '@shared/agent/structuredMarkers';
import { describeFrequency } from '@shared/scheduledTasks/describe';
import { describeWhen } from '@/lib/scheduledTaskFormat';
import { navigateToPage } from '@/lib/pageNavigator';
import { useScheduledTaskStore } from '@/stores/scheduledTaskStore';

/**
 * 定时任务确认卡（2026-07-20 拍板）：Oru 创建定时任务后给一张整行小卡——
 * 频率 + 下次运行 + 右端「管理」跳定时任务页，解决「建了却不知道去哪看」。
 *
 * 触发采信 result.structured.scheduledTask（创建确实落盘才有，与文件产物同一套事实标记模式）；
 * 卡内容从 scheduledTaskStore 实时取（后续改频率/暂停，卡跟着最新事实走），任务已删则整卡不渲染。
 */
export function collectCreatedTaskIds(toolCalls: ToolCall[] | undefined): string[] {
  const ids: string[] = [];
  for (const tool of toolCalls ?? []) {
    if (tool.status !== 'success' || tool.result?.isError) continue;
    if (normalizeToolName(tool.name) !== 'manage_scheduled_task') continue;
    const taskId = readStructuredMarkers(tool.result?.structured).scheduledTask?.taskId;
    if (typeof taskId === 'string' && !ids.includes(taskId)) ids.push(taskId);
  }
  return ids;
}

export function ScheduledTaskCreatedCards({ toolCalls }: { toolCalls?: ToolCall[] }) {
  const ids = collectCreatedTaskIds(toolCalls);
  const groups = useScheduledTaskStore((s) => s.groups);
  if (ids.length === 0) return null;
  // taskId → groupId 去重：AI 建多规则任务时多个 marker 指向同一组，只渲一张卡（review M3）
  const groupIds: string[] = [];
  for (const id of ids) {
    const g = groups.find((x) => x.rules.some((r) => r.taskId === id));
    if (g && !groupIds.includes(g.groupId)) groupIds.push(g.groupId);
  }
  return (
    <>
      {groupIds.map((gid) => (
        <ScheduledTaskCreatedCard key={gid} groupId={gid} />
      ))}
    </>
  );
}

function ScheduledTaskCreatedCard({ groupId }: { groupId: string }) {
  const { t } = useTranslation('chat');
  const { t: tTask } = useTranslation('scheduledTask');
  const group = useScheduledTaskStore((s) => s.groups.find((g) => g.groupId === groupId));
  if (!group) return null; // 已删：过期的确认卡比没有更糟
  const when = group.enabled && group.nextRunAt != null ? describeWhen(group.nextRunAt) : null;
  // 频率：多规则合并成一行（单规则与原来逐像素一致）；分隔符走 i18n
  const freq = group.rules.map((r) => describeFrequency(r.spec, r.stopAfterRuns, tTask)).join(tTask('common:listSeparator'));
  return (
    <div className="flex w-full items-center gap-3 rounded-sm border border-border bg-elevated px-3.5 py-2.5">
      <span className="grid h-7 w-7 shrink-0 place-items-center rounded-xs bg-accent-soft">
        <Clock size={15} strokeWidth={1.8} className="text-accent-deep" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-medium text-text-primary">{group.title}</span>
        <span className="block truncate text-xs text-text-tertiary">
          {freq}
          {when ? ` · ${t('scheduledCard.nextRun', { when })}` : ''}
        </span>
      </span>
      <button
        type="button"
        onClick={() => navigateToPage('scheduledTask')}
        className="ml-auto shrink-0 rounded-xs px-1.5 py-0.5 text-xs text-accent-deep transition-colors duration-150 hover:bg-accent-soft"
      >
        {t('scheduledCard.manage')}
      </button>
    </div>
  );
}
