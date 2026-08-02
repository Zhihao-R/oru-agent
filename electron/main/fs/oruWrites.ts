/**
 * oruWrites —— Oru 自有写盘链路的近期写入登记（safeWrite 落盘时记录）。
 *
 * 唯一消费方：bash 脚本执行后的 mtime+size 校验——执行窗口内经 Oru 自己落盘的路径
 * 要排除在"执行期间 X.csv 发生了变化"告警之外（否则用户保存别的表会被误报）。
 */
const writes = new Map<string, number>();
const PRUNE_AFTER_MS = 10 * 60 * 1000;
const PRUNE_THRESHOLD = 512;

export function recordOruWrite(absPath: string): void {
  const now = Date.now();
  writes.set(absPath, now);
  if (writes.size > PRUNE_THRESHOLD) {
    for (const [path, t] of writes) {
      if (now - t > PRUNE_AFTER_MS) writes.delete(path);
    }
  }
}

export function wasWrittenByOruSince(absPath: string, sinceMs: number): boolean {
  const t = writes.get(absPath);
  return t !== undefined && t >= sinceMs;
}
