/**
 * 计划清单展示卡（S32·G49）—— Oru 用 todo 工具列的工作计划，逐项标进度。随 chat.todo 更新、
 * 切对话时取初值（useTodoSync）。空清单不占位。
 *
 * 默认收起为单行（进度 n/m + 点阵 + 当前进行项 + 卡住计数），点击展开看全部（限高 200px 内滚）——
 * 长任务清单几十条时不挤压消息流（2026-07-19 话-1）。**卡住的项在收起时也要能被看见**：它是最需要
 * 用户注意的状态，不能只在展开后才出现。in_progress 用 accent 强调、stuck 用 warn、done/removed 划掉。
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { selectTodoItems, useTodoStore } from '@/stores/todoStore';
import { TODO_STATUS_META } from '@shared/todo';
import type { TodoItem } from '@shared/types';

/**
 * 一种状态一行，读一个状态的完整长相不用跳三处（与 TODO_STATUS_META「加一种状态加一行」同一模式）。
 * dot=收起态的点、mark=展开态的符号、content=正文。accent 在做 / warn 卡住 / 淡 = 已了结或未开始。
 */
const STATUS_STYLE: Record<TodoItem['status'], { dot: string; mark: string; content: string }> = {
  pending: { dot: 'border border-border-heavy', mark: 'text-text-secondary', content: 'text-text-primary' },
  in_progress: { dot: 'animate-pulse bg-accent', mark: 'text-accent', content: 'text-text-primary' },
  stuck: { dot: 'bg-warn', mark: 'text-warn', content: 'text-text-primary' },
  // done 用半透明 accent 与 in_progress 的实心拉开——只靠脉冲区分的话，静止帧与 reduce-motion 下
  // 两者完全一样（tokenColor 已让 /NN 对 var() 色生成，那条「不生成」的老限制早已不成立）
  done: { dot: 'bg-accent/50', mark: 'text-text-tertiary', content: 'text-text-tertiary line-through' },
  removed: { dot: 'border border-border', mark: 'text-text-quaternary', content: 'text-text-quaternary line-through' },
};

export function TodoPanel({ conversationId }: { conversationId: string }) {
  const { t } = useTranslation('chat');
  const items = useTodoStore(selectTodoItems(conversationId));
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const done = items.filter((it) => it.status === 'done').length;
  const stuck = items.filter((it) => it.status === 'stuck').length;
  // 分母剔掉「不做了」的项（2026-07-28 PM 拍板）：一份「3 项做完 + 2 项不做了」的清单已经了结，
  // 显示 3/5 读起来仍像没做完就被放弃——而卡片留到下一轮才撤，图的正是「全做完」这最后一帧。
  const total = items.length - items.filter((it) => it.status === 'removed').length;
  const current = items.find((it) => it.status === 'in_progress');
  return (
    <div className="rounded-sm border border-border bg-elevated text-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3.5 py-2 text-left text-xs text-text-tertiary"
      >
        <ChevronRight
          size={12}
          strokeWidth={1.6}
          className={cn('shrink-0 text-text-quaternary transition-transform', open && 'rotate-90')}
        />
        <span className="font-medium text-text-secondary">{t('todo.title')}</span>
        <span className="tabular-nums">
          {done}/{total}
        </span>
        {/* 卡住计数：收起态也要看得见（点阵在清单 >16 项时不渲染，光靠点阵会漏掉这条最该被看见的信息） */}
        {stuck > 0 ? (
          <span className="shrink-0 text-warn">{t('todo.stuckCount', { count: stuck })}</span>
        ) : null}
        {/* 点阵：每项一颗。清单过长（>16）不点阵，n/m 计数已足够表达进度，避免几十颗点不换行
            反把计数/当前项挤没（review 修复）。 */}
        {items.length <= 16 ? (
          <span className="flex shrink-0 items-center gap-1">
            {items.map((it, i) => (
              <span key={i} className={cn('h-1.5 w-1.5 rounded-full', STATUS_STYLE[it.status].dot)} />
            ))}
          </span>
        ) : null}
        {!open && current ? (
          <span className="min-w-0 truncate text-accent-deep">· {current.content}</span>
        ) : null}
      </button>
      {open ? (
        <ul className="flex max-h-[200px] flex-col gap-1 overflow-y-auto px-3.5 pb-2.5">
          {items.map((it, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className={STATUS_STYLE[it.status].mark}>{TODO_STATUS_META[it.status].mark}</span>
              {/* 原因与正文是**兄弟**节点，不能嵌在划线 span 里：line-through 由祖先绘制、子元素
                  取消不掉，嵌进去会把「为什么不做了」这句说明一起划掉（真机验收发现）。
                  卡住的原因必显（缺了就占位点名——「卡住却不说卡在哪」正是要暴露的事）；
                  removed 有就显、没有不占位（覆盖时系统自动补的留痕项本来就没原因）。 */}
              <span className="min-w-0">
                <span className={STATUS_STYLE[it.status].content}>{it.content}</span>
                {it.note ? (
                  <span className="text-text-tertiary"> —— {it.note}</span>
                ) : it.status === 'stuck' ? (
                  <span className="text-text-tertiary"> —— {t('todo.noReason')}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
