/**
 * Token 估算（v0.2 → v0.4）
 *
 * 各家 backend tokenizer 不同；用一个通用近似算法保守高估，避免低估漏触发主动压缩。
 *
 * 算法：
 * - CJK 字符（中文、日文、韩文常用区段）按 1.5 token / 字符
 * - 其他字符（英文 / 数字 / 标点 / 空格）按 0.28 token / char（约 3.6 char/token，跟 GPT 系实测吻合）
 *
 * 误差容忍 ±15%；保守倾向高估（宁可早压缩不要晚压缩）。
 *
 * v0.4 关键：result.persistedRef 存在时按 preview 估算（"实际发 LLM 的字符"），
 * 不按 detail——detail 全文留在 JSONL 仅给 UI，发 LLM 走 preview，估算必须对齐这条语义，
 * 否则源头落盘的"让大返回值不撞压缩阈值"意图破。
 *
 * 不引第三方 tokenizer 库的原因：
 * - 各家 tokenizer 实现不同（Claude / GPT / Gemini），用一种估算覆盖所有反而误差更可控
 * - 减一个依赖，本地零成本
 */
import type { ChatMessage } from '@shared/types';

const CJK_REGEX = /[　-〿぀-ゟ゠-ヿ㐀-䶿一-鿿가-힯＀-￯]/;

/** 估算一段纯文本的 token 数（取整）。
 *
 * 用整数缩放避免浮点漂移：cjk × 1.5 + other × 0.28 = (cjk × 150 + other × 28) / 100
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjkCount = 0;
  let otherCount = 0;
  for (const ch of text) {
    if (CJK_REGEX.test(ch)) cjkCount += 1;
    else otherCount += 1;
  }
  return Math.ceil((cjkCount * 150 + otherCount * 28) / 100);
}

/**
 * 估算单条 ChatMessage 的 token 数。
 *
 * v0.4：toolCall.result 有 persistedRef 时按 preview 估算（发 LLM 的真实字符）。
 */
export function estimateMessageTokens(msg: ChatMessage): number {
  let total = estimateTokens(msg.text);
  for (const tc of msg.toolCalls) {
    total += estimateTokens(tc.name);
    total += estimateTokens(JSON.stringify(tc.input));
    if (tc.result) {
      const resultText =
        tc.result.persistedRef?.preview ?? tc.result.detail ?? tc.result.summary;
      total += estimateTokens(resultText);
    }
  }
  return total;
}

/**
 * 估算整段 history 的 token 数（按 estimateMessageTokens 累加）。
 */
export function estimateHistoryTokens(history: ChatMessage[]): number {
  let total = 0;
  for (const m of history) {
    total += estimateMessageTokens(m);
  }
  return total;
}

