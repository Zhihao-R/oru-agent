/**
 * 调试面板专用的耗时格式化——统一秒（s），不出现 ms / m / 复合单位。
 *
 * 规则（按"心算尺度统一"原则，三档够用）：
 *   <  10s    两位小数： 0.02s / 9.01s
 *   < 100s    一位小数： 78.1s
 *   ≥ 100s    整数：    125s
 *
 * 见 docs/prd/2026-05-10-debug-redesign-prd.md §2.2
 */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 0) return '0s';
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)}s`;
  if (s < 100) return `${s.toFixed(1)}s`;
  return `${s.toFixed(0)}s`;
}
