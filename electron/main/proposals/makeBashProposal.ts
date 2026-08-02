/**
 * 构造 BashProposal 的辅助。emit 端按行为分类（2026-07-30 拍板）置 forceApproval：
 *   forceApproval = isDestructive（含 opaque）|| 有覆盖目标 || 对外投递需确认
 * 保证破坏性 / 未知命令、脚本将覆盖已存在文件、或对外投递（S04：非用户逐字地址且
 * 本对话未批过同目标）时，router 无论审批开关都停下等确认。
 * 命令能力门已取消（决策 6）：不再有次使用的「启用命令执行能力」授权卡。
 */
import type { BashProposal, DeliveryTarget, GrantScope } from '@shared/types';
import { newProposalId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { isCatastrophic } from '../fs/bashCommand';
import { deliveryScope } from '../agent/outbound/deliveryGate';

export function buildBashProposal(args: {
  conversationId: string;
  command: string;
  description?: string;
  isDestructive: boolean;
  isReadOnly: boolean;
  segments: BashProposal['segments'];
  timeout?: number;
  runInBackground?: boolean;
  cwd?: string;
  overwriteTargets?: string[];
  /** 对外投递目标（S04）——用户逐字地址已在 emit 端免除，传进来的就是真投递 */
  delivery?: DeliveryTarget[];
  /** 投递是否需弹卡确认（会话级已批过同目标时为 false，delivery 仍保留供 S26 收口） */
  deliveryNeedsApproval?: boolean;
}): BashProposal {
  const catastrophic = isCatastrophic(args.command);
  const delivery = args.delivery?.length ? args.delivery : undefined;
  return {
    kind: 'bash',
    status: 'pending',
    id: newProposalId(),
    ownerId: getCurrentOwnerId(),
    conversationId: args.conversationId,
    title: '执行命令',
    description: args.description ?? args.command,
    createdAt: Date.now(),
    command: args.command,
    isDestructive: args.isDestructive,
    isReadOnly: args.isReadOnly,
    segments: args.segments,
    timeout: args.timeout,
    runInBackground: args.runInBackground,
    cwd: args.cwd,
    overwriteTargets: args.overwriteTargets?.length ? args.overwriteTargets : undefined,
    delivery,
    // 火灰断路器：删根/家、抹盘、格式化——危险模式也硬拦（审批模式 PRD）
    catastrophic,
    // 通用强制确认字段：破坏性（含 opaque）/ 将覆盖已存在文件 / 对外投递 → 即使无审批也停下
    // （覆盖确认是表格 PRD 的「脚本写文件总守卫」：撞上已存在文件必须人工确认）
    forceApproval:
      args.isDestructive ||
      (args.overwriteTargets?.length ?? 0) > 0 ||
      args.deliveryNeedsApproval === true,
    // 可「始终允许」的后果 scope（行为分类拍板）：未知命令（opaque）从 {destructive} 拆出单列
    // {unknown}（决策 5）——授予破坏性不再连带免掉看不透的命令。灾难级不给 grantable（永不免卡）；
    // 投递目标提不出收件人（deliveryScope=null）则整条不给 grantable——有一个不可持久授权的理由，
    // 就不该因其余已授权而免卡（emit 端「全部命中才免卡」的前提）。
    grantable: buildBashGrantable(args, catastrophic, delivery),
  };
}

/** 组装 bash 提案的可授权 scope；返回 undefined = 不可免卡（灾难级 / 含不可持久授权的投递目标）。 */
function buildBashGrantable(
  args: { isDestructive: boolean; segments: BashProposal['segments']; overwriteTargets?: string[] },
  catastrophic: boolean,
  delivery: DeliveryTarget[] | undefined,
): GrantScope[] | undefined {
  if (catastrophic) return undefined;
  const deliveryScopes = (delivery ?? []).map(deliveryScope);
  if (deliveryScopes.some((s) => s === null)) return undefined; // 有目标提不出收件人 → 永远弹卡
  const scopes: GrantScope[] = [];
  // opaque 与逐段破坏性互斥（分析层第 0 层短路），未知命令单列 {unknown}、不挂 {destructive}
  if (args.segments.some((s) => s.opaque)) scopes.push({ kind: 'unknown' });
  else if (args.isDestructive) scopes.push({ kind: 'destructive' });
  if ((args.overwriteTargets?.length ?? 0) > 0) scopes.push({ kind: 'overwrite' });
  for (const s of deliveryScopes) if (s) scopes.push(s);
  return scopes.length ? scopes : undefined;
}
