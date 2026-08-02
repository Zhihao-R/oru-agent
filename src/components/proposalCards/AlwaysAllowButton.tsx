/**
 * 「始终允许」按钮（2026-07-30 决策 1）：文案标注授权类别与粒度，不再只有「始终允许」四个字。
 * - 单 scope：「始终允许：覆盖既有内容（整类）」/「始终允许：向 飞书：研发群 发送」；
 * - 一条提案挂多个 scope（合取免卡、点一次写入全部）：按钮按类计数，下方小字列出全部——
 *   卡面本身就是「为什么这次又问」的回答（决策 2，不做专门说明）。
 * 六张审批卡共用；scope 的人话取词来自行为注册表（shared/proposals/behaviors.ts 单源）。
 */
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { ActionProposal, GrantScope } from '@shared/types';
import { deliveryTargetLabel, rowForScope } from '@shared/proposals/behaviors';
import { Button } from '../ui/Button';

/** scope 短名（多 scope 明细列表用）：整类取注册表行标题，delivery 取「向 T 发送」。 */
function scopeShortName(scope: GrantScope, proposal: ActionProposal, t: TFunction): string {
  if (scope.kind === 'delivery') return t('behaviors.sendTo', { target: deliveryTargetLabel(scope, proposal) });
  const row = rowForScope(scope);
  return row ? t(row.titleKey) : scope.kind;
}

/** 按钮文案：单 scope 标注类别与粒度；多 scope 按类计数（明细在按钮下方小字）。 */
function buttonLabel(scopes: GrantScope[], proposal: ActionProposal, t: TFunction): string {
  if (scopes.length > 1) return t('behaviors.alwaysMultiple', { count: scopes.length });
  const s = scopes[0]!;
  if (s.kind === 'delivery') return t('behaviors.alwaysTo', { target: deliveryTargetLabel(s, proposal) });
  const row = rowForScope(s);
  return row ? t('behaviors.alwaysWhole', { name: t(row.titleKey) }) : t('remote.always');
}

export function AlwaysAllowButton({
  proposal,
  disabled,
  onClick,
}: {
  proposal: ActionProposal;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation('proposal');
  const scopes = proposal.grantable;
  if (!scopes?.length) return null;
  return (
    <span className="inline-flex max-w-72 flex-col items-end gap-0.5">
      <Button variant="outline" size="sm" type="button" onClick={onClick} disabled={disabled}>
        {buttonLabel(scopes, proposal, t)}
      </Button>
      {scopes.length > 1 ? (
        <span className="text-right text-[11px] leading-tight text-text-tertiary">
          {t('behaviors.alwaysMultipleHint', {
            list: scopes.map((s) => scopeShortName(s, proposal, t)).join(t('common:listSeparator')),
          })}
        </span>
      ) : null}
    </span>
  );
}
