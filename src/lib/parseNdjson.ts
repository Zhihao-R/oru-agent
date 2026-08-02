/**
 * NDJSON 行解析 —— 跳过坏行
 *
 * 容错末行残缺（kill -9 / Electron crash 时常发生）；前端调用方拿到的是干净的
 * DebugRecord[]，不需要再处理坏行。
 */
import type { DebugRecord } from '@shared/debug/types';

export function parseNdjson(text: string): DebugRecord[] {
  return text
    .split('\n')
    .filter((l) => l.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as DebugRecord;
      } catch {
        return null;
      }
    })
    .filter((r): r is DebugRecord => r !== null);
}
