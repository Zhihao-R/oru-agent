/**
 * 审批挡位闸 —— 写类工具共用的「实时读挡」+「只读硬拒」两个原语（只读重构 PRD 决策三）。
 *
 * 挡位是安全策略：中途收紧（如改成只读）必须**立即**生效，故判定一律实时 `getAgent(agentId)`，
 * 不读 `ToolContext.approvalMode` 快照（那只反映任务启动那刻）。proposeOrExecute（bash/文件写）、
 * mcp/plugin/skill 写类工具走 ctx 版包装；router 自动执行闸只有 agentId，走 `realtimeApprovalModeFor`
 * 并以 turn 起点的 agent 快照作回落——三条都经此一处取挡，口径不漂移。
 */
import type { AgentTool, ToolContext, ToolResult } from '@shared/agent/backend';
import type { ApprovalMode } from '@shared/types';
import { realtimeApprovalModeFor, getAgent } from '../store/agents';
import { getSettings } from '../../projects/store';
import { resolveEffectiveLang } from '../../i18n/effectiveLang';
import { t } from '../../i18n/t';
import { guardToolCall, noteToolResult } from '../circuitBreakerGuard';

// realtimeApprovalModeFor（实时读挡的单一实现）已下沉到 store/agents（与 getAgent 同处，供 backend 也用）。
export { realtimeApprovalModeFor };

/** ToolContext 版薄包装：回落到 ctx.approvalMode 快照。bash/文件写（proposeOrExecute）用这个自判。 */
export function realtimeApprovalMode(ctx: ToolContext): Promise<ApprovalMode> {
  return realtimeApprovalModeFor(ctx.agentId, ctx.approvalMode);
}

/**
 * 工具分发中央闸 —— 三个 backend（anthropic / openai / claudeCode 的 oru MCP 桥）都经此调 AgentTool，
 * 不再各自 `tool.execute`。声明位 `mutatesEnvironment: true` 的工具在只读挡下、触达 execute **之前**
 * 直接拒（不构造 proposal、不调 onProposal——否则模型先收到「已执行」乐观文案、卡片却被拒，回执割裂）。
 *
 * 这是把散在各写工具 execute 入口的手调只读拒收敛成单一咽喉点：新写工具只要在定义处标 flag 就零成本
 * 接入，不再靠人记加一行；忘标是编译错（flag 必填），不是静默放行。挡位实时读（中途切只读即时生效）。
 *
 * 注意只覆盖「恒变更」工具。两类例外标 false、不走本闸：① bash 是**条件**变更（按 isReadOnlyCommand
 * 判，只读挡仍允许 ls/cat）② 文件写把整条审批流水线（提案卡/破坏性确认/只读拒）委托给 proposeOrExecute
 * 统一拥有——二者都在 proposeOrExecute 内自判。SDK 内置写工具无 AgentTool 可标，走 claudeCode 的
 * PreToolUse 闸（makeReadonlyWriteGate）。外部 MCP 工具 2026-07-27 起改走反射、有了 AgentTool
 * （mutatesEnvironment: true），本闸是它们的第一道，PreToolUse 退为纵深第二道。
 */
export async function executeAgentTool(
  tool: AgentTool,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  // 断路器（G01/G04）：记这次调用、判是否失控（异常频繁 / 连续失败）。跳闸则弹卡阻塞等用户，
  // 「停止」直接返回、不触达 execute（刹车由 router 收到决定后触发）。放在只读闸之前——被只读拒的
  // 写类调用也是「调用」，模型对着只读挡狂刷写工具同样该被频率闸拦下。
  if ((await guardToolCall(ctx, Date.now())) === 'stopped') {
    return { text: '检测到工具调用失控（反复失败或异常频繁），已按你的选择停止本回合。' };
  }

  if (tool.mutatesEnvironment && (await realtimeApprovalMode(ctx)) === 'readonly') {
    const lang = resolveEffectiveLang((await getSettings().catch(() => null))?.language);
    const name = (await getAgent(ctx.agentId).catch(() => null))?.name || 'Oru';
    return {
      text: t('main:approval.readonlyToolBlocked', lang, { tool: tool.name, name }),
    };
  }

  // 中止：停止即停止一切动作，只读 / 有副作用一视同仁立即中止（PM 2026-07-12 拍板——宽限期时间
  // 不好把控，对大多数人「停止对话」就该停止一切）。撤销不了的副作用由模型据「被中止」回执诚实
  // 告知可能残缺（合成回执见 S03）。
  const result = await tool.execute(input, ctx);
  // 记回执：连续失败计数据此累加 / 清零（下一次工具调用的跳闸判据）。
  noteToolResult(ctx.conversationId, result.isError === true);
  return result;
}
