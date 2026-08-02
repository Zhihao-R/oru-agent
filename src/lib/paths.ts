/** 项目相对路径的最后一段（无 '/' 时返回原串）。 */
export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** 项目相对路径的父目录（顶层文件返回 ''——即项目根）。 */
export function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx < 0 ? '' : path.slice(0, idx);
}

/** cur 若等于 oldRel 或在其子树下，返回替换前缀后的新路径；否则 null（不命中）。 */
export function relocateUnder(cur: string, oldRel: string, newRel: string): string | null {
  if (cur === oldRel) return newRel;
  if (cur.startsWith(oldRel + '/')) return newRel + cur.slice(oldRel.length);
  return null;
}

/** cur 是否等于 path 或在其子树下。 */
export function isUnder(cur: string, path: string): boolean {
  return cur === path || cur.startsWith(path + '/');
}

/** 绝对路径 → 相对 base 的 POSIX 路径（abs 必在 base 下，本仓库 deck/项目根均如此）。 */
export function relativeTo(base: string, abs: string): string {
  const b = base.endsWith('/') ? base.slice(0, -1) : base;
  if (abs === b) return '';
  return abs.startsWith(b + '/') ? abs.slice(b.length + 1) : abs;
}
