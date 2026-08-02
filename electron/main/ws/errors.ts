/**
 * WS 层错误工具：从 unknown 提取 ErrorCode + 可读 message。
 *
 * 被 router.ts 和 runChatAndPersist.ts 共用——避免"helper 自带 helper"复制。
 */
import { ErrorCodes, type ErrorCode } from '@shared/types';

const KNOWN_CODES = new Set<string>(Object.values(ErrorCodes));

export function errCode(e: unknown): ErrorCode {
  if (e && typeof e === 'object' && 'code' in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === 'string' && KNOWN_CODES.has(c)) return c as ErrorCode;
  }
  return ErrorCodes.UNKNOWN;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
