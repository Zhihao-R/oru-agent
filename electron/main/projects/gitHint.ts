/**
 * 「项目未版本管理提示」的判定收口。
 *
 * 三类会改盘的操作（code proposal / 文件写 / 命令）走不同路径、不存在单一拦截出口，
 * 故由两个触发点（dispatchAsyncSubagent.ts、emitProposal.ts）各自解析出目标项目后调本 helper。
 * 「当天是否已提示」交给 markGitHintShown 在锁内判定（并发去重），拿到 true 才 emit。
 *
 * 只对**真会改项目文件**的提案发：emitProposal 现在也承载 MCP / 扩展装卸 / deck，那些改的是
 * ~/.oru 下的运行环境，跟「这个项目有没有做版本管理」无关，提示挂过去是错位。
 */
import type { ToolContext } from '@shared/agent/backend';
import type { Project } from '@shared/types';
import { isGitRepo, markGitHintShown } from './store';

export async function maybeShowGitHint(ctx: ToolContext, project: Project | null): Promise<void> {
  // 家目录任务（project 为 null）或已是 git 仓 → 无需提示
  if (!project || isGitRepo(project.path)) return;
  // 锁内判定 + 标记：仅本次从「未提示」翻转为「已提示」才继续（每项目每天一次、并发去重）
  if (!(await markGitHintShown(project.id))) return;
  await ctx.onGitHint?.();
}
