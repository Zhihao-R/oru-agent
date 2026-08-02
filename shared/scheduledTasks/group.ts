/**
 * TaskGroup 的活跃/已结束判定——纯谓词，主进程 scope 过滤与渲染端清单分档共用一份。
 *
 * 这是承重的 parity 逻辑：服务端 filterGroupsByScope 与前端 active/ended 分档必须同口径，
 * 否则同一组会在两处被归到不同区。谓词只读已构造好的 TaskGroup（不做聚合，故可放 shared）。
 *
 * 关键：分档看「组内是否还有活着的游标」而非 group.nextRunAt——group.nextRunAt 只算 enabled 规则，
 * 整组暂停时它是 null，但组并未终结（游标仍在），须留在 active 显示「已暂停」（与单条任务逐像素一致）。
 */
import type { TaskGroup } from '../types';

/** 终结：组内每条规则都已无下次游标（一次性已跑 / 周期跑满）。对齐单条 task.nextRunAt==null。 */
export function isGroupEnded(group: TaskGroup): boolean {
  return group.rules.every((r) => r.nextRunAt == null);
}

/** 活跃：组内尚有任一规则留着游标（含暂停但未终结的）。对齐单条 task.nextRunAt!=null。 */
export function isGroupActive(group: TaskGroup): boolean {
  return group.rules.some((r) => r.nextRunAt != null);
}
