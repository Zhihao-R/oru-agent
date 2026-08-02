/**
 * 项目规范能力 —— 目标项目 CLAUDE.md 的唯一注入路径（C2 收拢完成）。
 *
 * 初期只覆盖 subagentCoder（修分叉 1：它手拼 prompt、原本看不到项目规范）；
 * twinMain/twinSubagent 曾走 buildStableSystemContext 直读——但该段随"当前关注项目"变，
 * 放第一层意味着切项目就击穿第一断点（含子 agent 共享缓存）。C2 起三方受众都由本能力
 * 承载（第二层 capabilityPrompt）：切项目只击穿第二层，第一层缓存保住。
 */
import type { Capability } from '../types';
import { loadProjectClaudeMdSection } from '../../stableSystemContext';

export const projectClaudeMdCapability: Capability = {
  id: 'project-claude-md',
  audience: ['twinMain', 'twinSubagent', 'subagentCoder'],
  buildPrompt: (ctx) => loadProjectClaudeMdSection(ctx.activeProjectId),
};
