/**
 * 聚合唯一入口（多触发规则）：把多条共享 groupId 的底层 ScheduledTask 合并成用户可见的 TaskGroup。
 *
 * 硬约束：所有「把底层 tasks 合并成用户可见任务」的逻辑只能在这里——列表页 / 通知中心 / 错过区 /
 * AI list 工具一律调它，禁止各处各自 group by（违反系统性、会埋「同一任务被拆成多条显示」的体验 bug）。
 * 放主进程侧、不放 shared/：聚合只在主进程发生，前端只从 RPC 拿 groups（不诱发前端本地聚合绕开 RPC 的双源）。
 */
import type { ScheduledTask, TaskGroup, TaskGroupRule } from '@shared/types';
import { MAX_RUN_HISTORY } from './store';

function ruleOf(t: ScheduledTask): TaskGroupRule {
  return {
    taskId: t.id,
    spec: t.spec,
    stopAfterRuns: t.stopAfterRuns,
    nextRunAt: t.nextRunAt,
    enabled: t.enabled,
    missedAt: t.missedAt,
  };
}

/** 组内活跃规则里最近的 nextRunAt（全 null → null）。活跃 = enabled 且有游标。 */
function groupNextRunAt(bucket: ScheduledTask[]): number | null {
  const live = bucket
    .filter((t) => t.enabled && t.nextRunAt != null)
    .map((t) => t.nextRunAt as number);
  return live.length ? Math.min(...live) : null;
}

function buildGroup(bucket: ScheduledTask[]): TaskGroup {
  // 组主 = createdAt 最早那条：取其 title/prompt/runLocation/createdBy（组内一致性契约保证等价）。
  // createdAt 相等（老数据同批建）时按 id 兜底，排序确定、rules 顺序不随 readdir 漂移。
  const byCreatedAsc = [...bucket].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
  );
  const head = byCreatedAsc[0];

  const missed = bucket.map((t) => t.missedAt).filter((m): m is number => m != null);
  const withLastRun = bucket.filter((t) => t.lastRun);
  const lastRun = withLastRun.length
    ? withLastRun.reduce((a, b) => ((b.lastRun!.at > a.lastRun!.at ? b : a))).lastRun
    : undefined;

  // 历史组级合并、按 at 降序、截上限（不区分来自哪条规则——当前设计稿无「按规则筛历史」入口，YAGNI）
  const runHistory = bucket
    .flatMap((t) => t.runHistory ?? [])
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_RUN_HISTORY);

  return {
    groupId: head.groupId,
    title: head.title,
    prompt: head.prompt,
    runLocation: head.runLocation,
    createdBy: head.createdBy,
    enabled: bucket.some((t) => t.enabled),
    rules: byCreatedAsc.map(ruleOf), // rules 按 createdAt 升序稳定
    nextRunAt: groupNextRunAt(bucket),
    missedAt: missed.length ? Math.max(...missed) : undefined,
    dismissed: bucket.some((t) => t.dismissed) ? true : undefined,
    lastRun,
    runHistory,
    createdAt: head.createdAt,
  };
}

export function groupTasks(tasks: ScheduledTask[]): TaskGroup[] {
  const buckets = new Map<string, ScheduledTask[]>();
  for (const t of tasks) {
    const arr = buckets.get(t.groupId);
    if (arr) arr.push(t);
    else buckets.set(t.groupId, [t]);
  }
  const groups = [...buckets.values()].map(buildGroup);
  // 组间排序：活跃优先、近的靠前（与现列表排序口径对齐）；全终结（nextRunAt=null）排后、按 createdAt 兜底稳定
  return groups.sort((a, b) => {
    if (a.nextRunAt == null && b.nextRunAt == null) return a.createdAt - b.createdAt;
    if (a.nextRunAt == null) return 1;
    if (b.nextRunAt == null) return -1;
    return a.nextRunAt - b.nextRunAt;
  });
}
