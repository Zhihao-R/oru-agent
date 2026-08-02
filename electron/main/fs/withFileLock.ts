/**
 * 文件锁内跑一段 read-modify-write——确保实体文件存在（lockfile 需要可锁的文件）后加锁，
 * 跑 fn，无论成败都释放。整块 RMW 持同一把锁，避免"读在锁外、写才加锁"的丢更新。
 *
 * memory 的 user/project profile、事件索引都共用这一份，不各自手抄 ensure-file + lock + finally。
 */
import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import lockfile from 'proper-lockfile';

export type LockRetries = { retries: number; minTimeout: number; maxTimeout?: number };

const DEFAULT_RETRIES: LockRetries = { retries: 5, minTimeout: 50 };

export async function withFileLock<T>(
  absPath: string,
  fn: () => Promise<T>,
  retries: LockRetries = DEFAULT_RETRIES,
): Promise<T> {
  await fs.mkdir(dirname(absPath), { recursive: true });
  // 创建空文件以便 lockfile 能锁
  try {
    await fs.access(absPath);
  } catch {
    await fs.writeFile(absPath, '', 'utf-8');
  }
  // onCompromised 默认是 `throw err`，而它在 mtime 更新定时器回调里被调——
  // 定时器内同步抛会成 uncaughtException 直接崩主进程。改为记录后放行（锁失效非致命）。
  const release = await lockfile.lock(absPath, {
    retries,
    onCompromised: (err) => console.error('[oru.lock] 锁失效（已忽略，不崩进程）:', absPath, err),
  });
  try {
    return await fn();
  } finally {
    // 锁在 fn 执行期间被判失效（onCompromised 已置 released）时，release 会回 ERELEASED——
    // 此时锁已没了，这个错误无意义，吞掉；其余释放失败照常记录。
    await release().catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ERELEASED') console.error('[oru.lock] release 失败:', absPath, err);
    });
  }
}
