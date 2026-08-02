/**
 * 定时任务名派生（打磨 6b）：留空 = 取 prompt 前 20 字自动命名——兑现名称框 placeholder
 * 「留空则自动命名」的承诺。UI 提交 / AI 工具路径共用这一处（曾两处各写一份 `trim() || slice(0,20)`）。
 * 用户编辑时清空名称 = 重新自动命名（清空即留空，与 placeholder 语义一致）。
 */
export function deriveTaskTitle(title: string | undefined, prompt: string): string {
  return title?.trim() || prompt.trim().slice(0, 20);
}
