/**
 * 敏感信息脱敏 —— 落盘前对 DebugRecord 做基础替换
 *
 * 本期是占位透传（Oru 的 system prompt / 工具结果不会出现 API key——key 在 HTTP
 * header 不在 prompt body）。保留这个调用点是为了将来真要加脱敏时改一处就行，
 * 不需要重新埋点。
 *
 * 详见 docs/tech/2026-05-10-debug-module-tech-design.md §4.4。
 */

import type { DebugRecord } from '@shared/debug/types';

export function redact(rec: DebugRecord): DebugRecord {
  return rec;
}
