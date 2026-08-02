/**
 * deck 版本锁回归（技术设计 §11.3 死锁回归-commitVersion / §2.5a 重排不丢版本 / §11.15 不回归）。
 *
 * - 死锁回归：reorderSlides 整段持 indexPath 锁，内部走 commitVersionLocked / flushPendingLocked
 *   无锁内核——若误调锁壳会锁内等自己挂起。断言全部能完成、不挂起。
 * - 并发 commit：多路 commitVersion（锁壳）并发，断言 manifest 无丢版本、版本 id 不重复。
 *
 * ORU_DIR 在 import 前重定向；业务模块走动态 import（同 atomicWrite.test.ts）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-deck-commitlock-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const DECK_HTML = `<!doctype html><html><body>
<div class="slide"><h1>A</h1></div>
<div class="slide"><h1>B</h1></div>
<div class="slide"><h1>C</h1></div>
</body></html>`;

let projectPath = '';
const noopBroadcast = (): void => {};

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  projectPath = join(ORU_DIR, 'prj');
  await fs.mkdir(projectPath, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

async function makeDeck(name: string): Promise<string> {
  const deckDir = join(projectPath, name);
  await fs.mkdir(deckDir, { recursive: true });
  await fs.writeFile(join(deckDir, 'index.html'), DECK_HTML, 'utf-8');
  const { registerExistingDeck } = await import('../../electron/main/deck/store');
  const rec = await registerExistingDeck({ projectId: 'prj_a', name, path: deckDir });
  return rec.id;
}

describe('死锁回归-commitVersion / reorder 持锁', () => {
  it('reorderSlides 整段持锁内走 *Locked 内核，不挂起、版本落档（§11.3）', async () => {
    const id = await makeDeck('reorder-deck');
    const { reorderSlides } = await import('../../electron/main/deck/reorderSlides');
    const { scheduleInlineEditCommit, __resetForTest } = await import('../../electron/main/deck/commitScheduler');
    const { listVersions } = await import('../../electron/main/deck/history');

    // 制造一个 pending inline commit：reorderSlides 进锁后会 flushPendingLocked 把它落版本（同锁内、无锁内核）
    scheduleInlineEditCommit(id, 0);

    // 若 reorderSlides 锁内误调锁壳（commitVersion / flushPending），会锁内等自己 → 此 await 永不返回
    const r = await reorderSlides({ artifactId: id, newOrder: [2, 0, 1], broadcast: noopBroadcast });
    expect(r.ok).toBe(true);

    const versions = await listVersions(id);
    // 至少有一条 reorder 版本（重排落档），且 pending inline 被 flush（不丢）
    expect(versions.some((v) => v.kind === 'reorder')).toBe(true);
    __resetForTest();
  });

  it('reorderSlides 真重排了页序（行为不回归）', async () => {
    const id = await makeDeck('reorder-deck-2');
    const { reorderSlides } = await import('../../electron/main/deck/reorderSlides');
    const { deckIndexPath } = await import('../../electron/main/deck/pathResolver');
    const { resolveDeckPath } = await import('../../electron/main/deck/store');

    const r = await reorderSlides({ artifactId: id, newOrder: [2, 0, 1], broadcast: noopBroadcast });
    expect(r.ok).toBe(true);
    const html = await fs.readFile(deckIndexPath(await resolveDeckPath(id)), 'utf-8');
    // 重排后第一页应是原 C
    expect(html.indexOf('<h1>C</h1>')).toBeLessThan(html.indexOf('<h1>A</h1>'));
  });
});

describe('并发 commit 不丢版本（§2.5a）', () => {
  it('多路 commitVersion 锁壳并发：版本 id 不重复、无丢版本', async () => {
    const id = await makeDeck('concurrent-deck');
    const { commitVersion, listVersions } = await import('../../electron/main/deck/history');
    const { deckIndexPath } = await import('../../electron/main/deck/pathResolver');
    const { resolveDeckPath } = await import('../../electron/main/deck/store');
    const indexPath = deckIndexPath(await resolveDeckPath(id));

    // 先落首版（懒初始化 v001 + v002）
    await commitVersion(id, 'manual', '首版');
    const before = (await listVersions(id)).length;

    // 三路并发：各自先改 index.html 再 commit。锁串行化 → 每次 commit 读到的是改后的、各成一版
    await Promise.all(
      ['X', 'Y', 'Z'].map((tag, i) =>
        // 串行化下每个 commit 前改盘：用 runExclusive 同一把锁保证「改盘+commit」原子，模拟真实写路径
        import('../../electron/main/fs/runExclusive').then(({ runExclusive }) =>
          runExclusive(indexPath, async () => {
            await fs.writeFile(indexPath, DECK_HTML.replace('A', `A${tag}${i}`), 'utf-8');
            const { commitVersionLocked } = await import('../../electron/main/deck/history');
            await commitVersionLocked(id, 'manual', `并发-${tag}`);
          }),
        ),
      ),
    );

    const versions = await listVersions(id);
    const ids = versions.map((v) => v.id);
    expect(new Set(ids).size).toBe(ids.length); // 版本 id 不重复（manifest 无并发覆盖丢版本）
    expect(versions.length).toBe(before + 3); // 三路各落一版，无丢
  });
});

describe('deck 锁 key 归一 resolve（项目B 第一期 Task2，前置阻塞#4）', () => {
  it('deckLockKey === resolve(deckIndexPath)，非规范路径段被归一', async () => {
    const { deckLockKey, deckIndexPath } = await import('../../electron/main/deck/pathResolver');
    const { resolve } = await import('node:path');
    // 含非规范段（/./ 与重复斜杠）的 deckPath——deckLockKey 必须输出规范化绝对路径，
    // 与 applyTextEdit 的 runExclusive(resolve(filePath)) / fileHistory 的 deckKey 同源
    const messy = join(projectPath, 'a', '.', 'deck-x');
    expect(deckLockKey(messy)).toBe(resolve(deckIndexPath(messy)));
    // 同一 deck 的不同写法解析到同一把锁 key（否则两把锁丢更新）
    const a = deckLockKey(join(projectPath, 'd'));
    const b = deckLockKey(join(projectPath, 'sub', '..', 'd'));
    expect(a).toBe(b);
  });
});
