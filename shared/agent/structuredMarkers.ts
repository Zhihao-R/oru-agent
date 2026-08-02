/**
 * 工具 result.structured 里跨进程约定的「事实标记」形状——主进程写端 `satisfies` 本类型，
 * 渲染层读端经 readStructuredMarkers 统一窄化，防两端各写字面量"对暗号"漂移。
 *
 * 标记的存在语义 = 对应动作**真正发生**（落盘 / 创建 / 启动）：审批被拒、只读挡拦下的
 * 回执不带标记，渲染层组件（产物条 / 打开按钮 / 定时任务卡 / 后台命令行）据此判定。
 */
/** 「本轮文件变更」的操作类型（PRD 2026-07-27 第 7 项·决策二：四种操作全进、各标类型） */
export type FileChangeOp = 'create' | 'modify' | 'delete' | 'move' | 'rename';

export type StructuredMarkers = {
  /**
   * 遗留形状（仅读兼容）：2026-07-28 前各写类工具落盘的单文件标记。写端已全部迁到
   * fileChanges，历史消息仍带它——读端把它映射为 create/modify 单元素。别再往这里写。
   */
  file?: { path: string; created: boolean };
  /**
   * 文件变更事实（统一形状）：path=操作后的绝对路径（delete 例外：被删前的路径），
   * from 只有 move/rename 有（操作前的绝对路径，供渲染层把同轮旧路径条目并过来）。
   * 写端：write/edit/append/convert_csv 直接申报；manage_files 三操作申报；
   * bash 按「调用当下预期申报 + 执行后核验」，未通过核验的不进这里。
   */
  fileChanges?: Array<{ path: string; op: FileChangeOp; from?: string }>;
  /** manage_scheduled_task create：创建已落盘 */
  scheduledTask?: { taskId: string };
  /** bash run_in_background：后台命令登记表 id（bash-bg-*） */
  backgroundCommand?: { id: string };
};

/** 读端统一入口：只做类型窄化，字段级的 typeof 校验仍由消费方做（老数据/缺字段兜底）。 */
export function readStructuredMarkers(
  structured: Record<string, unknown> | undefined,
): StructuredMarkers {
  return (structured ?? {}) as StructuredMarkers;
}
