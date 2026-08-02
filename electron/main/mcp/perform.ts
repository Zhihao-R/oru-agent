/**
 * mcp.* 三类提案的纯执行内核——只做事、返回结果或抛错，不碰 proposal.status、不发 chip。
 *
 * 与其余五族同构（`skills/installer` / `skills/manager` / `plugins/installer` / `plugins/upgrader` /
 * `proposals/performDeckCreate`）：内核住在自己的领域模块，编排层（同步路径的 proposeOrExecute
 * 与无人等待时的独立执行器）按需 import。原先这三个函数留在 `proposals/standaloneExec.ts` 里，
 * 于是工具层要为拿一个纯执行内核去 import 编排层——方向反了，且六族里唯独 MCP 破例。
 *
 * 只有 'failed' 算装失败——'probe_failed' 是「连上了但探活没过」，registry 的设计是工具仍可调用
 * （reflectTool execute 时报错），不该被当作硬失败回滚。
 */
import type { McpInstallProposal, McpUpdateProposal, McpDeleteProposal } from '@shared/types';
import { createServer, updateServer, deleteServer, getRuntimeState } from './registry';
import { failure } from '../proposals/failure';

export async function performMcpInstall(
  proposal: McpInstallProposal,
): Promise<{ serverId: string }> {
  const cfg = await createServer(proposal.config);
  if (cfg.enabled) {
    const rt = getRuntimeState(cfg.id);
    if (rt?.status === 'failed') {
      // 回滚 settings 中的「半坏 server」——避免污染 Settings 列表
      await deleteServer(cfg.id).catch((e) =>
        console.warn(`[oru.mcp] 回滚 deleteServer 失败 (${cfg.id}):`, e),
      );
      throw failure('mcpStartFailed', { error: rt.lastError ?? 'unknown' });
    }
  }
  return { serverId: cfg.id };
}

export async function performMcpUpdate(proposal: McpUpdateProposal): Promise<{ serverId: string }> {
  const result = await updateServer(proposal.serverId, proposal.patch);
  if (!result) throw failure('mcpServerNotFound', { serverId: proposal.serverId });
  if (result.enabled) {
    const rt = getRuntimeState(proposal.serverId);
    if (rt?.status === 'failed') {
      // update 失败不回滚 settings——配置已写新值。回执只给诊断事实（技术原文），
      // 「去 Settings ▸ 拓展调整」那句给人的指引只出现在上屏文案里（见 proposalFailure 译文）。
      throw failure('mcpUpdateStartFailed', { error: rt.lastError ?? 'unknown' });
    }
  }
  return { serverId: proposal.serverId };
}

export async function performMcpDelete(proposal: McpDeleteProposal): Promise<{ serverId: string }> {
  const ok = await deleteServer(proposal.serverId);
  if (!ok) throw failure('mcpServerNotFound', { serverId: proposal.serverId });
  return { serverId: proposal.serverId };
}
