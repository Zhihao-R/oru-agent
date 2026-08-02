/**
 * ISO / YYYY-MM-DD → 月、日两段（保留零填充的原始字符串）。非法返回 null。
 * 主页多处（档案修订 MM·DD、项目最近活动、项目详情眉标）共用同一拆分，避免各写一遍。
 */
export function monthDayParts(iso: string | undefined): [string, string] | null {
  const p = (iso ?? '').slice(0, 10).split('-');
  return p.length < 3 || !p[1] || !p[2] ? null : [p[1], p[2]];
}
