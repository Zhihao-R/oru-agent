import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ToolCall } from '@shared/types';
import { cn } from '@/lib/cn';
import { basename } from '@/lib/paths';
import { canOpenTarget, fileChangeTargets, type FileChangeTarget } from '@/lib/toolFileTargets';
import { openProjectFile } from '@/lib/openProjectFile';
import { useProjectStore } from '@/stores/projectStore';
import { fileChipIcon } from './fileChipIcon';

/**
 * 回合级「本轮文件变更」条（2026-07-20 拍板：方案 B；2026-07-28 PRD 第 7 项·决策二扩展为
 * 四种操作全进、各标操作类型）——回合结束后把本轮的文件变更聚合成一张整行条，可开的 chip
 * 点击在右栏打开。一条 assistant 消息至多一张（噪音上界）；文件数超过折叠阈值才显示计数与
 * 折叠开关，且默认折叠。判定采信 structured 事实标记（见 toolFileTargets）。
 */
const FOLD_THRESHOLD = 6;

/**
 * 聚合一条消息的文件变更为净状态：按「项目 + 相对路径」去重（跨项目同名相对路径是两个文件，
 * 不能静默合并）。move/rename 把同轮落在旧路径上的条目并入新路径（旧路径已不存在，不留条目）；
 * 同键合并时 create 对 modify 保持「新建」（本轮新出现的文件，这个事实比后续修改信息量大），
 * 其余后者胜（含 delete 覆盖一切——净状态是删除，打开入口随之消失）。
 *
 * manage_files 也操作目录，净状态同样要跟上（PM 2026-07-28 裁决）：删目录清掉其下子条目、
 * 移/改名目录把子条目迁到新前缀。前缀判定带路径分隔符（`tmp/`），不误伤 `tmp2/a.md`。
 */
export function collectTurnFileChanges(toolCalls: ToolCall[] | undefined): FileChangeTarget[] {
  const byPath = new Map<string, FileChangeTarget>();
  for (const tool of toolCalls ?? []) {
    for (const raw of fileChangeTargets(tool)) {
      let { fromKey, ...target } = raw;
      if (fromKey) {
        const moved = byPath.get(fromKey);
        if (moved) {
          byPath.delete(fromKey);
          if (moved.op === 'create') target = { ...target, op: 'create' };
        }
        for (const [k, v] of [...byPath]) {
          if (!k.startsWith(`${fromKey}/`)) continue;
          byPath.delete(k);
          const relPath = `${target.relPath}/${k.slice(fromKey.length + 1)}`;
          byPath.set(`${target.projectId}:${relPath}`, { ...v, relPath });
        }
      }
      const key = `${target.projectId}:${target.relPath}`;
      if (target.op === 'delete') {
        for (const k of [...byPath.keys()]) if (k.startsWith(`${key}/`)) byPath.delete(k);
      }
      const prev = byPath.get(key);
      const op = prev?.op === 'create' && target.op === 'modify' ? 'create' : target.op;
      byPath.set(key, { ...target, op });
    }
  }
  return [...byPath.values()];
}

export function TurnFileChangesStrip({ toolCalls }: { toolCalls?: ToolCall[] }) {
  const { t } = useTranslation('chat');
  const projectId = useProjectStore((s) => s.activeProjectId);
  // projects 必须进依赖：collectTurnFileChanges 内部按项目列表反查归属（owningProject 非响应式
  // 读 store），项目增删后历史消息的变更条要跟着重算，否则冻结在旧快照上
  const projects = useProjectStore((s) => s.projects);
  const targets = useMemo(() => collectTurnFileChanges(toolCalls), [toolCalls, projects]);
  const foldable = targets.length > FOLD_THRESHOLD;
  const [expanded, setExpanded] = useState(false);
  if (targets.length === 0) return null;
  return (
    <div className="w-full rounded-sm border border-border bg-elevated px-2.5 py-2">
      <div className="flex items-center">
        <span className="px-1 text-xs text-text-tertiary">{t('fileChanges.label')}</span>
        {foldable ? (
          <>
            <span className="ml-1 text-xs text-text-secondary">
              {t('fileChanges.count', { count: targets.length })}
            </span>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              aria-expanded={expanded}
              className="ml-auto rounded-xs px-1.5 py-0.5 text-xs text-text-tertiary transition-colors duration-150 hover:bg-hover hover:text-text-secondary"
            >
              {expanded ? t('fileChanges.collapse') : t('fileChanges.expand')}
            </button>
          </>
        ) : null}
      </div>
      {!foldable || expanded ? (
        <div className="mt-1.5 grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-1.5">
          {targets.map((target) => (
            <FileChangeChip
              key={`${target.projectId}:${target.relPath}`}
              target={target}
              isActiveProject={target.projectId === projectId}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

// 操作类型徽标色（决策二「各标操作类型」）：新建沿用强调色、删除用告警色提示「这个文件没了」，
// 其余三种是中性事实、与标签同灰——色彩种类保持最少
const OP_BADGE_CLASS: Record<FileChangeTarget['op'], string> = {
  create: 'text-accent-deep',
  modify: 'text-text-tertiary',
  delete: 'text-warn',
  move: 'text-text-tertiary',
  rename: 'text-text-tertiary',
};

function FileChangeChip({
  target,
  isActiveProject,
}: {
  target: FileChangeTarget;
  isActiveProject: boolean;
}) {
  const { t } = useTranslation('chat');
  const projectName = useProjectStore(
    (s) => s.projects.find((p) => p.id === target.projectId)?.name,
  );
  const { Icon, className } = fileChipIcon(target.relPath);
  const inner = (
    <>
      <Icon size={12} strokeWidth={1.8} className={cn('shrink-0', className)} />
      <span className="truncate">{basename(target.relPath)}</span>
      {/* 非当前项目：标出归属项目名——不标的话它长得和本项目文件一样却点不动，是困惑不是信息 */}
      {!isActiveProject && projectName ? (
        <span className="shrink-0 truncate text-2xs text-text-tertiary">{projectName}</span>
      ) : null}
      <span className={cn('shrink-0 text-2xs', OP_BADGE_CLASS[target.op])}>
        {t(`fileChanges.op.${target.op}`)}
      </span>
    </>
  );
  const base =
    'flex min-w-0 items-center gap-1.5 rounded-xs border border-border bg-sunken-2 px-2 py-1 text-xs text-text-primary';
  // 打开入口只给仍存在（非删除）且当前活跃项目内可开的文件（Tab 身份不含项目维度，
  // 见 openProjectFile 决策注释）；其余只展示变更事实，不给点击态
  if (!canOpenTarget(target, isActiveProject ? target.projectId : null)) {
    return (
      <span
        title={
          !isActiveProject && projectName
            ? t('fileChanges.otherProject', { name: projectName })
            : target.relPath
        }
        className={base}
      >
        {inner}
      </span>
    );
  }
  return (
    <button
      type="button"
      title={target.relPath}
      onClick={() => openProjectFile(target.projectId, target.relPath)}
      className={cn(base, 'text-left transition-colors duration-150 hover:border-accent-line hover:bg-accent-soft')}
    >
      {inner}
    </button>
  );
}
