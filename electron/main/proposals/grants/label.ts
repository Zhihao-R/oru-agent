/**
 * 授权 scope → 已授权清单展示用的人话标签（S24 · G30）。
 * 标签在授权那一刻按 owner 语言烘焙进 grants.json——整类（单例 / category）取行为注册表
 * 行标题（shared/proposals/behaviors.ts 单源，与审批卡 / 设置页策略表同一份词），delivery
 * 取当时那条投递目标的 label（携人话收件人名，如「飞书:研发群」），scope 里只有 recipient
 * id 兜不出人名。
 */
import type { ActionProposal, GrantScope } from '@shared/types';
import { grantKey } from '@shared/proposals/grantKey';
import { deliveryTargetLabel, rowForScope } from '@shared/proposals/behaviors';
import { t } from '../../i18n/t';

export function grantLabel(scope: GrantScope, proposal: ActionProposal, lang: 'zh' | 'en'): string {
  if (scope.kind === 'delivery') {
    return t('proposal:grant.deliveryTo', lang, { target: deliveryTargetLabel(scope, proposal) });
  }
  const row = rowForScope(scope);
  return row ? t(`proposal:${row.titleKey}`, lang) : grantKey(scope);
}
