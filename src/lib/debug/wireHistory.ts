/**
 * wireHistory 兜底 helper——集中处理 inference_view 事件的三种状态：
 * - present：adapter 跑过且有 wireHistory（正常路径，空数组也算 present——adapter 跑了只是输入退化）
 * - resume：adapter 未跑（claudeCode SDK 原生续 session）；由 adapterRan === false 明确标识
 * - legacy：老 ndjson 文件，缺 adapterRan / wireHistory 字段
 *
 * 注意：早期实现曾用"wireHistory 为空数组"作 resume 信号——但 adapter 在边界输入下也会返回 []，
 * 用合法值表达异常状态会撞车，改用独立 boolean `adapterRan`。
 */
import type { NormalizedMessage } from '@shared/agent/normalizedMessage';
import type { DebugRecord } from '@shared/debug/types';

export type WireHistoryDisplay =
  | { kind: 'present'; messages: NormalizedMessage[] }
  | { kind: 'resume' }
  | { kind: 'legacy' };

export function getWireHistoryDisplay(
  record: DebugRecord<'inference_view'>,
): WireHistoryDisplay {
  const p = record.payload;
  // 老 ndjson：adapterRan 缺；后备兼容 wireHistory 缺
  if (p.adapterRan === undefined || p.wireHistory === undefined) {
    return { kind: 'legacy' };
  }
  if (p.adapterRan === false) return { kind: 'resume' };
  return { kind: 'present', messages: p.wireHistory };
}
