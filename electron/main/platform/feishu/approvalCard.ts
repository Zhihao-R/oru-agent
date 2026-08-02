/**
 * 飞书互动卡片渲染（S24 · G30 下半）——平台无关的 RemoteApprovalCard 渲染成飞书 interactive 卡片
 * JSON。纯函数、单测覆盖；按钮文案按 owner 语言取词，每个按钮 value 携 {proposalId, action}，
 * 用户点击经 card.action.trigger 事件回流，adapter normalize 成 ApprovalCallbackEvent。
 */
import type { RemoteApprovalCard } from '@shared/platform/message';
import { t } from '../../i18n/t';

type Lang = 'zh' | 'en';

/** 待决审批卡：标题 + 正文（已脱敏）+ 允许/始终允许/拒绝 按钮。 */
export function buildFeishuApprovalCard(card: RemoteApprovalCard, lang: Lang): unknown {
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: card.title } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: card.body } },
      {
        tag: 'action',
        actions: card.buttons.map((b) => ({
          tag: 'button',
          text: { tag: 'plain_text', content: t(`proposal:remote.${b}`, lang) },
          type: b === 'reject' ? 'danger' : b === 'always' ? 'primary' : 'default',
          value: { proposalId: card.proposalId, action: b },
        })),
      },
    ],
  };
}

/** 终态卡：决定落定后原地改写成的只读卡（已批准 / 已拒绝，无按钮）。 */
export function buildFeishuTerminalCard(decision: 'approved' | 'rejected', lang: Lang): unknown {
  return {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'div', text: { tag: 'lark_md', content: `**${t(`proposal:remote.${decision}`, lang)}**` } }],
  };
}
