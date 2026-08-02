/**
 * runExclusive —— 按 key 串行化异步任务的通用锁。
 *
 * 同一 key 的任务排成一条 Promise 链：新任务挂在前一个任务的 `.then` 之后，
 * 整块 read-modify-write 都在链内跑，避免"读在锁外、写才入锁"的丢更新
 * （详 CLAUDE.md「await 后重检共享状态」/ memory `feedback_atomic_rmw_must_be_in_lock`）。
 *
 * 抽自 deck/annotations.ts 的 mutateAnnotations 写锁——那里按 artifactId 分链，
 * 这里把 key 泛化成任意字符串（applyTextEdit 用 filePath）。
 *
 * 链尾追踪：每次入链都把"吞掉错误后的 tail"记进 Map；任务结束后若该 key 的
 * 链尾仍是自己（其后无新任务排队）则删除条目，避免 Map 随访问过的 key 无限膨胀。
 */
const chains = new Map<string, Promise<unknown>>();

export async function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const result = prev.then(fn);
  // 链上错误不能拖垮后续任务——swallow 后的 tail 才是排队基线；caller 仍从 result 拿到原始返回/异常
  const tail = result.catch(() => undefined);
  chains.set(key, tail);
  // 自己跑完后清理：仅当链尾还是自己（无后继排进来）才删，否则会误删别人的链
  tail.finally(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return result;
}
