/**
 * sessionKey（tech design §4.1）——把来源压成一个确定性主键，供去重 / 串行队列 / get-or-create
 * 锁三处共用。第一期 DM only：DM 里 chat 即身份，key 只取 platform + chatId，不掺 userId
 * （掺了会让同一会话因发送者字段抖动算出两个 key）。
 */
import type { SessionSource } from '@shared/platform/message';

export function sessionKey(s: SessionSource): string {
  return `oru:${s.platform}:dm:${s.chatId}`;
}
