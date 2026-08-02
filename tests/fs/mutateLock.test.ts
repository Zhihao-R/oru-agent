/**
 * S27 · G97 非 md 文件树操作入 workfile 锁（并发）。
 *  - csv 的 rename/move/trash 与其实时保存（commitWorkfileWrite）共用 resolve(源) 这把锁 → 串行、不交错；
 *  - 锁内重检源存在性：被别的临界区先删掉 → 返回 not-found（不把已移走的文件凭空写回 / 不裸抛）。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-mutatelock-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

let renameEntry!: typeof import('../../electron/main/fs/mutate').renameEntry;
let moveEntry!: typeof import('../../electron/main/fs/mutate').moveEntry;
let trashEntry!: typeof import('../../electron/main/fs/mutate').trashEntry;
let runExclusive!: typeof import('../../electron/main/fs/runExclusive').runExclusive;
let setTrashItemImplForTest!: typeof import('../../electron/main/fs/trash').setTrashItemImplForTest;

let root: string;

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  ({ renameEntry, moveEntry, trashEntry } = await import('../../electron/main/fs/mutate'));
  ({ runExclusive } = await import('../../electron/main/fs/runExclusive'));
  ({ setTrashItemImplForTest } = await import('../../electron/main/fs/trash'));
  setTrashItemImplForTest(async (p: string) => rmSync(p, { recursive: true, force: true })); // 测试环境无系统回收站
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'oru-mutlock-'));
  writeFileSync(join(root, 'a.csv'), 'v1');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('G97 非 md 入锁·并发', () => {
  it('改名在锁被占时阻塞、释放后才进行（证明 rename 在 workfile 锁内串行）', async () => {
    const key = resolve(join(root, 'a.csv'));
    let releaseHeld: () => void = () => {};
    const held = new Promise<void>((r) => (releaseHeld = r));
    const holder = runExclusive(key, async () => {
      await held; // 一直占着锁
    });
    let renamed = false;
    const pRename = renameEntry(root, 'a.csv', 'b.csv').then((r) => {
      renamed = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(renamed).toBe(false); // 锁被占 → 改名排队等待，未完成

    releaseHeld();
    await holder;
    const r = await pRename;
    expect(renamed).toBe(true);
    expect(r).toEqual({ status: 'ok', path: 'b.csv' });
  });

  it('锁内重检源：等锁期间源被删 → rename 返回 not-found（不凭空重建）', async () => {
    const key = resolve(join(root, 'a.csv'));
    const holder = runExclusive(key, async () => {
      rmSync(join(root, 'a.csv')); // 持锁期间删掉源（模拟另一临界区）
    });
    const pRename = renameEntry(root, 'a.csv', 'b.csv'); // 排在同一把锁后
    await holder;
    const r = await pRename;
    expect(r.status).toBe('not-found');
    expect(existsSync(join(root, 'b.csv'))).toBe(false); // 没把已删的源凭空重建到新名
  });

  it('锁内重检源：move 等锁期间源被删 → not-found', async () => {
    await fs.mkdir(join(root, 'dst'), { recursive: true });
    const key = resolve(join(root, 'a.csv'));
    const holder = runExclusive(key, async () => {
      rmSync(join(root, 'a.csv'));
    });
    const pMove = moveEntry(root, 'a.csv', 'dst');
    await holder;
    expect((await pMove).status).toBe('not-found');
  });

  it('锁内重检源：trash 等锁期间源被删 → not-found（不裸抛）', async () => {
    const key = resolve(join(root, 'a.csv'));
    const holder = runExclusive(key, async () => {
      rmSync(join(root, 'a.csv'));
    });
    const pTrash = trashEntry(root, 'a.csv');
    await holder;
    expect((await pTrash).status).toBe('not-found');
  });
});
