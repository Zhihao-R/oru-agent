/**
 * 提案的自动执行判定——桌面 onProposal（ws/handlers/turnArgs.ts）与远程渠道
 * （platform/platformTurn.decidePlatformProposal）共用，单一事实源：口径改这里，两侧天然同步
 * （S02 · G73 review 消掉「两处镜像漂移」）。
 *
 * 口径：
 * - forceApproval（破坏性 / 未授权 / 覆盖 / 对外投递 / 装卸类）恒不自动执行——停下等确认
 *   （远程无人可点即拦下）。装卸类原先靠一份 kind 常量在这里另判，那是第二个事实源、且与
 *   proposeOrExecute「只认 forceApproval」的口径打架；判定已收敛到提案字段，常量随之退场。
 * - 派工（code）不过挡位（S02 · G73，理想页 subagent#Mode）：派工本身不改变环境，任何挡位都可派；
 *   改变环境的是 subagent 执行的操作，由它们逐个过闸（只读挡派出的 subagent 继承只读）。
 * - 其余写类在只读挡不自动执行。
 */
import type { ApprovalMode } from '@shared/types';

export function shouldAutoExecuteProposal(
  proposal: { forceApproval?: boolean; kind?: string },
  mode: ApprovalMode,
): boolean {
  if (proposal.forceApproval) return false;
  if (proposal.kind === 'code') return true;
  return mode !== 'readonly';
}
