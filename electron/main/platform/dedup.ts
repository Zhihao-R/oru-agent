/**
 * MessageDedup（tech design §4.3）——按 (sessionKey, messageId) 记最近处理过的消息，平台重投
 * 同一条时 admit 返回 false 让 gateway 忽略，防破坏性操作执行两次。
 *
 * 用 Map 的插入序当 LRU：超 cap 淘汰最旧。规模极小（重投只在网络抖 / 重连后短窗内发生）。
 * 落盘跨重启（S11 · G07）：给定 persistPath 时构造即从盘加载已处理集、每次 admit 后异步回写，
 * 应用重启后同一条重投仍被挡住——不再有「重启后短暂窗口不去重」的破绽。持久化是尽力而为：
 * 加载损坏 / 回写失败都静默降级为纯内存（去重是防重不是承重存储，不该因盘故障崩收发）。
 */
import { readFileSync } from 'node:fs';
import { safeWriteAsync } from '../fs/safeWrite';

export class MessageDedup {
  private readonly seen = new Map<string, true>();
  /**
   * 串行写链：并发发出两轮 safeWriteAsync（tmp+rename）时，第一轮的 rename 可能在第二轮之后完成，
   * 让旧快照赢；串行化保证按 admit 顺序落盘、最新快照最后 rename。不是多余的锁，勿删。
   */
  private writeChain: Promise<void> = Promise.resolve();

  /** persistPath 缺省 = 纯内存（单测 / 无持久化需求）；给定则加载并回写落盘。 */
  constructor(
    private readonly cap = 500,
    private readonly persistPath?: string,
  ) {
    if (persistPath) this.load(persistPath);
  }

  /** 构造时从盘 seed 已处理集（同步，只在 gateway 连接时发生一次）。 */
  private load(path: string): void {
    let keys: unknown;
    try {
      keys = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return; // 无文件 / 读坏 → 空集起步（去重尽力而为，损坏不阻塞收发）
    }
    if (!Array.isArray(keys)) return;
    for (const k of keys) if (typeof k === 'string') this.seen.set(k, true);
    // 加载后照样收敛到 cap（盘上可能是更大 cap 时代写的）——保留最近的尾部。
    while (this.seen.size > this.cap) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
  }

  /** 首次出现返回 true（放行），重复返回 false（忽略）。 */
  admit(sessionKey: string, messageId: string): boolean {
    const k = `${sessionKey} ${messageId}`;
    if (this.seen.has(k)) return false;
    this.seen.set(k, true);
    if (this.seen.size > this.cap) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }
    this.persist();
    return true;
  }

  /** 异步回写当前快照（原子 tmp+rename）；串行化保证最新快照最后落盘。无 persistPath 即 no-op。 */
  private persist(): void {
    if (!this.persistPath) return;
    const path = this.persistPath;
    const snapshot = JSON.stringify([...this.seen.keys()]);
    this.writeChain = this.writeChain.then(() =>
      safeWriteAsync(path, snapshot).catch(() => {
        // 回写失败静默：内存态已更新、本进程去重不受影响，仅牺牲这一拍的跨重启保证。
      }),
    );
  }
}
