/**
 * 提案卡终态行（S24 · G31）——非 pending 提案卡只当「决定存证」，一行柔和文字。
 *
 * 收敛前各卡分别渲染 executing / executed / failed / rejected 四态的独立文案；G31 后
 * 执行过程与成败改由工具调用自己在对话流里展示，卡片不再复述。故只留两种落定呈现：
 * - rejected                → 已拒绝
 * - 其余（executing/executed/failed）→ 已批准
 *
 * 留痕卡（proposal.trace）是第三种：它**从没有人批准过**——全放挡下装卸类不弹审批卡，它只是
 * 事后补的一张记录。照搬「已批准」会让这张卡对用户撒一个新的谎（正是本轮改动要消灭的失真形态），
 * 故按真实成败说；失败时连错因一并给出——用户没见过审批卡，这一行是他唯一的现场。
 */
import { useTranslation } from 'react-i18next';
import type { ActionProposal } from '@shared/types';

export function ProposalTerminalLine({ proposal }: { proposal: ActionProposal }) {
  const { t } = useTranslation('proposal');
  if (proposal.trace) {
    const failed = proposal.status === 'failed';
    return (
      <div className="mt-3 text-xs text-text-tertiary">
        {failed ? t('trace.failed') : t('trace.done')}
        {failed && proposal.failureMessage ? (
          <span className="ml-1 break-all text-warn">{proposal.failureMessage}</span>
        ) : null}
      </div>
    );
  }
  const label = proposal.status === 'rejected' ? t('remote.rejected') : t('remote.approved');
  return <div className="mt-3 text-xs text-text-tertiary">{label}</div>;
}
