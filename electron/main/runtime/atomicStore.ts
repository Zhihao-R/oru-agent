/**
 * 全 store 共用的写入工具：串行 + 原子化。
 *
 * 设计：每个 store 一个独立 WriteQueue（不跨 store 共享 chain），
 * 全局串行同 store 的写避免 read-modify-write 撕裂；tmp+rename 让断电至少
 * 不破坏已有数据。
 *
 * 当前规模不做 per-key chain（per-task / per-conv 锁）——全局单 chain 简单可证，
 * 真出现性能瓶颈再升级。
 */
import { safeWriteAsync } from '../fs/safeWrite';

export type WriteQueue = {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
  writeAtomic(path: string, data: string): Promise<void>;
};

export function createWriteQueue(): WriteQueue {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(fn, fn);
      chain = next.catch(() => undefined);
      return next;
    },
    // 原子写内核收敛到 fs/safeWrite（此前这里是第二套手写 tmp+rename）
    writeAtomic: (path, data) => safeWriteAsync(path, data),
  };
}
