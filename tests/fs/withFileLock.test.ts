/**
 * withFileLock 单元测试——重点验证 onCompromised 不再用 proper-lockfile 默认的 `throw err`。
 *
 * 原问题：默认 onCompromised 在 mtime 更新定时器回调里同步抛 → uncaughtException 崩主进程。
 * 这里 mock proper-lockfile，截下传入的 onCompromised，断言调用它不抛。
 */
import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const { lockMock } = vi.hoisted(() => ({ lockMock: vi.fn() }));
vi.mock('proper-lockfile', () => ({ default: { lock: lockMock } }));

import { withFileLock } from '../../electron/main/fs/withFileLock';

describe('withFileLock - onCompromised 不崩进程', () => {
  it('锁失效时调用方传入的 onCompromised 只记录、不抛（不致 uncaughtException）', async () => {
    let captured: ((err: Error) => void) | undefined;
    lockMock.mockImplementation(async (_path: string, opts: { onCompromised: (e: Error) => void }) => {
      captured = opts.onCompromised;
      return async () => {};
    });

    const p = join(tmpdir(), `oru-withfilelock-${Date.now()}.txt`);
    const result = await withFileLock(p, async () => 'ok');
    expect(result).toBe('ok');

    expect(captured).toBeTypeOf('function');
    // 默认 proper-lockfile 是 `(err) => { throw err }`——必须被覆盖成不抛
    expect(() => captured!(new Error('compromised'))).not.toThrow();
  });

  it('锁失效后 release 抛 ERELEASED 被吞，withFileLock 不向上 reject', async () => {
    lockMock.mockImplementation(async () => {
      // 模拟 proper-lockfile：锁已 released，release 回 ERELEASED
      return async () => {
        throw Object.assign(new Error('Lock is already released'), { code: 'ERELEASED' });
      };
    });

    const p = join(tmpdir(), `oru-withfilelock-rel-${Date.now()}.txt`);
    await expect(withFileLock(p, async () => 'done')).resolves.toBe('done');
  });
});
