/**
 * 无工具在等时的提案执行路径——「独立执行器」。
 *
 * （原名 asyncExec.ts：那个名字来自「除 code 外的 kind 都走异步执行」的旧世界。装卸类同步化后
 * 它装的既不是 async 也不是「异步执行」，恰恰是同步路径以外的那一条，故改名。）
 *
 * 装卸类（mcp.* / plugin.* / skill.* / deck.create）的常规路径是同步的：工具调 proposeOrExecute，
 * 免审批直接执行、需审批则挂起等确认，真实成败作为 tool_result 在原轮回给模型。本模块服务剩下那些
 * **没有工具在等**的卡：
 *   1. 设置页起的卡（拓展页装 / 卸 / 升级、skill 新建与修改）——用户点确认后由这里执行；
 *   2. 渠道回合里挡位放行、无 waiter 的卡（decidePlatformProposal 判 execute）。
 * 判据不是 kind 而是提案自身的事实（hasToolAwaited），见 pendingDecision.ts。
 *
 * 与同步路径的分工：`perform*` 是共用的纯执行内核（只做事、抛错），本模块只加编排——
 * 迁 executing、拿真实终态迁 executed/failed、把 chip 交给唯一落点 outcomeChip。
 * 执行器不再自己迁终态，故也不再需要「终态以先到为准」那道兜底。
 *
 * 不处理 code propose——code propose 走 queue（enqueueTask）。
 */
import type { ActionProposal } from '@shared/types';
import type { ServerEvent } from '@shared/protocol';
import { transitionProposal } from './lifecycle';
import type { ProposalOutcome } from '@shared/proposals/outcome';
import { writeProposalOutcomeChip } from './outcomeChip';
import { surfaceFailureText } from './failure';
import { getSettings } from '../projects/store';
import { resolveEffectiveLang } from '../i18n/effectiveLang';

type Broadcast = (ev: ServerEvent) => void;

/**
 * in-flight proposal id 集——防同一 proposal 被两条路径同时驱动（桌面点确认 与 渠道放行；
 * spawn 5-30s 的中间窗口 status 仍是 pending，原 status 防抖无效）。
 */
const inflight = new Set<string>();

export function isExecuting(proposalId: string): boolean {
  return inflight.has(proposalId);
}

/* ── 独立执行器 ──────────────────────────────────────────────────── */

/** 各 kind 的执行结果里，编排层需要用到的部分。 */
type PerformResult = { serverId?: string; outcome: ProposalOutcome };

async function performByKind(proposal: ActionProposal, broadcast: Broadcast): Promise<PerformResult> {
  switch (proposal.kind) {
    case 'mcp.install': {
      const { performMcpInstall } = await import('../mcp/perform');
      return { serverId: (await performMcpInstall(proposal)).serverId, outcome: { ok: true } };
    }
    case 'mcp.update': {
      const { performMcpUpdate } = await import('../mcp/perform');
      return { serverId: (await performMcpUpdate(proposal)).serverId, outcome: { ok: true } };
    }
    case 'mcp.delete': {
      const { performMcpDelete } = await import('../mcp/perform');
      return { serverId: (await performMcpDelete(proposal)).serverId, outcome: { ok: true } };
    }
    case 'plugin.install': {
      const { performPluginInstall } = await import('../plugins/installer');
      const r = await performPluginInstall(proposal);
      return { outcome: { ok: true, name: r.name, warnings: r.warnings } };
    }
    case 'plugin.uninstall': {
      const { performPluginUninstall } = await import('../plugins/installer');
      return { outcome: { ok: true, name: (await performPluginUninstall(proposal)).name } };
    }
    case 'plugin.update': {
      const { performPluginUpdate } = await import('../plugins/upgrader');
      return { outcome: { ok: true, name: (await performPluginUpdate(proposal)).name } };
    }
    case 'skill.create': {
      const { performSkillCreate } = await import('../skills/manager');
      return { outcome: { ok: true, name: (await performSkillCreate(proposal)).name } };
    }
    case 'skill.patch': {
      const { performSkillPatch } = await import('../skills/manager');
      return { outcome: { ok: true, name: (await performSkillPatch(proposal)).name } };
    }
    case 'skill.install': {
      const { performSkillInstall } = await import('../skills/installer');
      return { outcome: { ok: true, name: (await performSkillInstall(proposal)).name } };
    }
    case 'deck.create': {
      const { performDeckCreate } = await import('./performDeckCreate');
      await performDeckCreate(proposal, broadcast);
      return { outcome: { ok: true } };
    }
    default:
      // 安全网：未登记 kind 硬失败而非静默标 executed。bash / file.write 等同步 kind 恒有工具在等，
      // 落到这里说明有 regression——硬失败能暴露，而非静默吞掉。
      throw new Error(`unknown proposal kind: ${(proposal as { kind: string }).kind}`);
  }
}

/**
 * 无工具在等时执行一条已批准的提案：迁 executing → 跑 perform → 按真实成败迁终态 + 写 chip。
 */
export async function runProposalStandalone(
  proposal: ActionProposal,
  broadcast: Broadcast,
): Promise<void> {
  if (proposal.kind === 'code') return;
  if (proposal.status !== 'pending') return;
  if (inflight.has(proposal.id)) return; // 已经在跑了
  inflight.add(proposal.id);

  // 开跑即迁 executing 占住状态——此后 reject 被 handler 的非 pending 防抖挡住，
  // 「拒绝=不执行」只在 pending 窗口内有效。插件下载安装、skill 写盘、deck 建壳同样有数秒
  // 执行窗口，统一占位不留暗角。
  transitionProposal(proposal, 'executing', broadcast);
  try {
    const { serverId, outcome } = await performByKind(proposal, broadcast);
    transitionProposal(proposal, 'executed', broadcast, { serverId });
    await writeProposalOutcomeChip(proposal, outcome, broadcast);
  } catch (e) {
    // 上屏侧（卡片 failureMessage / chip）按 owner 语言；已知失败取词、未知失败原样透传。
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    const failureMessage = surfaceFailureText(e, lang);
    transitionProposal(proposal, 'failed', broadcast, { failureMessage });
    await writeProposalOutcomeChip(proposal, { ok: false, error: failureMessage }, broadcast);
  } finally {
    inflight.delete(proposal.id);
  }
}
