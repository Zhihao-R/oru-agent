/**
 * 计划清单（todo）的状态元数据——每种状态的全部固有属性收在这一张表里，加第六种状态就加一行，
 * 四个字段都由 `satisfies Record<TodoStatus, …>` 强制穷尽（漏一个编译红）。
 *
 * 每个字段一个消费方：mark 给卡片渲染（**只给人看**，喂模型的文本用状态名，见 renderTodoLines）、
 * terminal 给注入与清掉判定、wantsNote 给回执点名、leavesTrace 给覆盖时的留痕判定。
 * **注入判据与清掉判据是 terminal 的正反面**——手写两套互为补集的状态集合，漏改一处就会出现
 * 「注入了一份马上被清掉的清单」，而这种不一致测试很难抓。
 */
import type { TodoItem, TodoStatus } from './types';

export const TODO_STATUS_META = {
  pending: { mark: '○', terminal: false, wantsNote: false, leavesTrace: false },
  in_progress: { mark: '◐', terminal: false, wantsNote: false, leavesTrace: true },
  stuck: { mark: '⊗', terminal: false, wantsNote: true, leavesTrace: true },
  done: { mark: '●', terminal: true, wantsNote: false, leavesTrace: false },
  // removed 被抹掉时走「原样保留」的独立分支（连 note 一起），不经 leavesTrace
  removed: { mark: '⊖', terminal: true, wantsNote: true, leavesTrace: false },
} as const satisfies Record<
  TodoStatus,
  {
    /** 卡片上的符号（只给人看） */
    mark: string;
    /** 到终点了吗——false 即「还悬着」，注入与清掉共用这一个字段 */
    terminal: boolean;
    /** 该写清原因吗（缺了在回执里点名，不拦） */
    wantsNote: boolean;
    /** 被覆盖抹掉时要补一条 removed 留痕吗——判据是「这一项开工过或卡住过吗」 */
    leavesTrace: boolean;
  }
>;

export const TODO_STATUSES = Object.keys(TODO_STATUS_META) as TodoStatus[];

/**
 * 还悬着的项数 = terminal 为 false 的项（待办 / 进行中 / 卡住）。
 * 一项都不剩即这份计划已了结（下一轮开始时清掉）；还剩着就继续每轮贴回眼前。
 *
 * 卡住算悬着：它是可逆的（前提解开就回到进行中），报的也是「这件活还没终结」这个真事。
 */
export function countOpenTodos(items: readonly TodoItem[]): number {
  return items.filter((it) => !TODO_STATUS_META[it.status].terminal).length;
}

/**
 * 喂给模型的清单文本——工具回执与每轮注入共用一份格式。
 *
 * 用状态名而不是符号：模型要写回的就是 `stuck` / `removed` 这些枚举，而符号↔状态的对照表在任何
 * 喂给它的文本里都不存在（`⊗` 与 `⊖` 尤其易混）。给人看的卡片才用符号（TODO_STATUS_META.mark）。
 */
export function renderTodoLines(items: readonly TodoItem[]): string {
  return items
    .map((it) => `[${it.status}] ${it.content}${it.note ? ` —— ${it.note}` : ''}`)
    .join('\n');
}
