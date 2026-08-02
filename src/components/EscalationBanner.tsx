/**
 * 顶部 banner：当有任意 task 进入 awaiting_user 状态时出现（子 agent 反问 ask_twin 等你回答）。
 * 多个时显徽章数字。点击展开第一个对应任务卡。
 * 注：后台命令审批的"待批卡未读"另由对话列表 per-conv 徽标承担（卡在对话流里、不在任务卡）。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle } from 'lucide-react';
import { useTaskStore } from '@/stores/taskStore';
import type { SubagentTask } from '@shared/types';

export function EscalationBanner() {
  const { t } = useTranslation('task');
  // 不能直接 useTaskStore((s) => s.escalatedTasks())：selector 每次返回新数组，
  // zustand Object.is 比较失败 → 触发重渲染 → 再调 selector → 无限循环
  // 改为订阅 tasks 字典本身（引用稳定），在组件层用 useMemo 派生
  const tasks = useTaskStore((s) => s.tasks);
  const setExpanded = useTaskStore((s) => s.setExpanded);
  const escalated: SubagentTask[] = useMemo(
    () => Object.values(tasks).filter((t) => t.status === 'awaiting_user'),
    [tasks],
  );

  if (escalated.length === 0) return null;

  const onClick = () => {
    const first = escalated[0];
    if (first) setExpanded(first.id, true);
    // 滚动到对应卡片：优先用 anchor
    requestAnimationFrame(() => {
      const el = document.getElementById(`task-card-${first?.id}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-2 border-b border-warn bg-warn-soft px-6 py-2 text-left text-xs text-warn"
    >
      <AlertCircle size={14} strokeWidth={1.5} />
      <span className="font-medium">
        {escalated.length === 1
          ? t('escalation.oneAsking', { title: escalated[0].proposalTitle })
          : t('escalation.manyAsking', { count: escalated.length })}
      </span>
      <span className="ml-auto text-[11px] text-warn">{t('escalation.jumpHint')}</span>
    </button>
  );
}
