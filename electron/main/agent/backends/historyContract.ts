/**
 * 跨 backend 契约：HTTP 后端（anthropic / openaiCompatible）不读 `input.userMessage`。
 *
 * `ConversationInput.userMessage` 是 claudeCode 专属的便利字段——只有它会兜底读。
 * anthropic / openaiCompatible 只 replay `history`、忽略 userMessage，故**当前 user 轮必须已在
 * history 末尾**（主对话由 runner 起流前 appendMessage 保证；后台调用由 `singleUserTurn` 保证）。
 *
 * 此前这条契约只活在字段注释里，抓不住违约：dream 曾传 `history:[] + userMessage` 到 HTTP 后端，
 * prompt 被静默丢弃、模型只收到 system prompt 空转（记忆 project_oru_backend_usermessage_contract_trap）。
 * 本 assert 把「静默丢 prompt」提前成起流前就抛的显式错误。
 *
 * 判据是「history 末尾必须是 user 轮」——这是**必要非充分**的近似：它封死「空 history / 末尾是
 * assistant 轮」这一类违约（含 dream 事故的确切形态），但**不**校验「末尾这条 user 轮的文本 ==
 * userMessage」。若调用方把新 userMessage 配上一条遗留的旧 user 轮末尾，assert 仍放行、prompt 照样
 * 静默丢——这个盲区在主对话侧已被下方 ensureCurrentTurnInHistory 按文本比对封死；backend 侧
 * 拿不到「本轮 user 是哪条」的独立信号、判据无法更精确，assert 保持现状作兜底网。
 */
import type { ChatMessage, BackendType } from '@shared/types';
import type { ConversationInput } from '@shared/agent/backend';
import { makeUserTurn } from '../singleUserTurn';
import { SYSTEM_NOTE_PREFIX } from '@shared/userTurn';

export function assertCurrentTurnInHistory(
  input: Pick<ConversationInput, 'history' | 'userMessage'>,
  backendLabel: string,
): void {
  const history = input.history ?? [];
  const last = history[history.length - 1];
  if (last?.role === 'user') return;
  const dropped =
    input.userMessage !== undefined
      ? `，userMessage=${JSON.stringify(input.userMessage.slice(0, 40))} 会被静默丢弃`
      : '';
  const got = history.length === 0 ? '空 history' : `末尾是 ${last?.role ?? '未知'} 轮`;
  throw new Error(
    `${backendLabel} 后端不读 userMessage：当前 user 轮必须在 history 末尾` +
      `（主对话靠 runner appendMessage、后台调用靠 singleUserTurn 保证），实收 ${got}${dropped}。`,
  );
}

/** 无 nudge 续跑（[重试]/审批后自动接续）补的系统旁白——喂 AI 的 prompt，i18n-exempt。 */
export const CONTINUE_NOTE = `${SYSTEM_NOTE_PREFIX}请接着上文继续。）`;

/**
 * 契约的兑现层：起流前把「当前轮输入不在 history 末尾」的 history 补成合规，只喂 backend、不落盘。
 *
 * 七条「非用户发起」路径（[重试] / loop 干活轮 / 审批续跑 / 断线自动接续 / 任务播报 /
 * 后台命令播报 / 冲突裁决回报）把当前轮输入只放在 userText（或没有），history 末尾停在
 * assistant 轮——这些形态是 claudeCode 时代的产物（它读 userMessage、能凭 session 续写），
 * HTTP 后端只 replay history，撞上面的 assert（[重试]/loop 报错）或播报静默失败。
 *
 * 规则（claude-code 原样返回，通道健在别喂两遍）：
 * - 末尾已是 user 轮且（无 userText 或文本 == userText）→ 原样返回（chat.send 已 appendMessage、
 *   拒绝提案后的系统记续跑，均合规）；
 * - 否则追加一条临时 user 轮：有 userText 用它（nudge 即当前轮输入），无则用 CONTINUE_NOTE
 *   （纯续跑语义）。临时轮只存在于本轮发给 backend 的视图里，下轮重读持久 history 自然消失。
 *
 * ⚠ 承重前提：文本比对判据依赖「调用方落盘的末尾 user 消息 text 与传给 runner 的 userText
 * 逐字同源」（现有路径均如此：chat.send 落盘与 userText 同取 req.text）。将来若有路径先落盘
 * **改写过**的文本（附件占位 / 清洗 / 截断）再把原文传 userText，会被误判为「未落盘」而静默
 * 追加双份 user 轮——改写落盘文本的新路径必须同步改这里的判据。
 */
export function ensureCurrentTurnInHistory(
  history: ChatMessage[],
  userText: string | undefined,
  backendType: BackendType,
  conversationId: string,
): ChatMessage[] {
  if (backendType === 'claude-code') return history;
  const last = history[history.length - 1];
  if (last?.role === 'user' && (userText === undefined || last.text === userText)) return history;
  const text = userText !== undefined && userText.length > 0 ? userText : CONTINUE_NOTE;
  return [...history, makeUserTurn(conversationId, text)];
}
