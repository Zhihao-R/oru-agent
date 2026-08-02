/**
 * FileHistory 通用快照层单测（技术设计 §11 死锁回归 + baseline 碰撞回归）
 *
 * 必须 process.env.ORU_DIR 重定向到 tmpdir + 动态 import，避免 runtime/paths 在 load 时锁死路径。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-filehistory-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

// 每个用例用独立 fileKey，互不串味
let seq = 0;
function freshKey(): string {
  return join(ORU_DIR, 'work', `wf-${seq++}.md`);
}

type FH = typeof import('../../electron/main/fs/fileHistory');
type SW = typeof import('../../electron/main/fs/safeWrite');
type RE = typeof import('../../electron/main/fs/runExclusive');
let FH!: FH;
let safeWriteAsync!: SW['safeWriteAsync'];
let runExclusive!: RE['runExclusive'];

beforeAll(async () => {
  await fs.mkdir(join(ORU_DIR, 'work'), { recursive: true });
  FH = await import('../../electron/main/fs/fileHistory');
  ({ safeWriteAsync } = await import('../../electron/main/fs/safeWrite'));
  ({ runExclusive } = await import('../../electron/main/fs/runExclusive'));
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

/** 模拟 §2.5b 落盘临界区：一次进 workfile 锁，先把磁盘当前版兜进历史，再写我的。 */
async function guardedWrite(workfile: string, kind: Parameters<FH['snapshot']>[1], next: string): Promise<void> {
  await runExclusive(workfile, async () => {
    let cur = '';
    try {
      cur = await fs.readFile(workfile, 'utf-8');
    } catch {
      // 文件还不存在——无当前版可兜
    }
    if (cur) await FH.snapshot(workfile, 'overwrite-guard', cur);
    await safeWriteAsync(workfile, next);
    if (kind !== 'overwrite-guard') await FH.snapshot(workfile, kind, next);
  });
}

describe('FileHistory 基本契约', () => {
  it('首次 snapshot 落库、lastHash 更新、可 restore', async () => {
    const key = freshKey();
    const ref = await FH.snapshot(key, 'initial', 'hello');
    expect(ref).not.toBeNull();
    expect(await FH.lastHash(key)).toBe(ref!.hash);
    expect(await FH.restore(key, ref!.id)).toBe('hello');
    expect(await FH.list(key)).toHaveLength(1);
  });

  it('内容未变 snapshot 返回 null、不增条目（no-op，§11.7）', async () => {
    const key = freshKey();
    await FH.snapshot(key, 'periodic', 'same');
    const again = await FH.snapshot(key, 'periodic', 'same');
    expect(again).toBeNull();
    expect(await FH.list(key)).toHaveLength(1);
  });

  it('clear 后该 fileKey 快照全删、不可 restore（§11.14 隐私）', async () => {
    const key = freshKey();
    const ref = await FH.snapshot(key, 'manual', 'secret');
    await FH.clear(key);
    expect(await FH.list(key)).toHaveLength(0);
    expect(await FH.lastHash(key)).toBeNull();
    await expect(FH.restore(key, ref!.id)).rejects.toThrow();
  });

  it('restore 不存在的快照抛错', async () => {
    const key = freshKey();
    await FH.snapshot(key, 'initial', 'x');
    await expect(FH.restore(key, 's999')).rejects.toThrow();
  });
});

describe('死锁回归', () => {
  it('死锁回归-snapshot：持 workfile 锁内触发 snapshot 不挂起（§11.2）', async () => {
    const key = freshKey();
    // workfile 锁与 history 小锁是两条独立链（key 前缀不同），锁内调 snapshot 必须能完成
    const ref = await runExclusive(key, async () => FH.snapshot(key, 'overwrite-guard', 'in-lock'));
    expect(ref).not.toBeNull();
    expect(await FH.lastHash(key)).toBe(ref!.hash);
  });

  it('死锁回归-GC：snapshot 触发 GC 不二次 enqueue 小锁、不挂起，且条数封顶（§11.4）', async () => {
    const key = freshKey();
    // 连续写超过 MAX_PER_FILE 条不同内容——每次 snapshot 内部都跑 GC（锁内直调，不得自排队死锁）
    for (let i = 0; i < FH.MAX_PER_FILE + 12; i++) {
      const ref = await FH.snapshot(key, 'periodic', `v${i}`);
      expect(ref).not.toBeNull(); // 内容每次都变，必有新快照
    }
    const all = await FH.list(key);
    expect(all.length).toBeLessThanOrEqual(FH.MAX_PER_FILE);
    // 最新一条永远在（lastHash 真相源不悬空）
    expect(await FH.lastHash(key)).toBe(all[all.length - 1].hash);
    expect(await FH.restore(key, all[all.length - 1].id)).toBe(`v${FH.MAX_PER_FILE + 11}`);
  }, 30000); // 212 次真实落盘验小文件封顶——全量并发下放宽超时（默认 5s 偏紧）
});

describe('manifest 损坏隔离保留（§Deg / G126）', () => {
  // 复刻 dirFor：sha256(fileKey)[:32]（内部函数不导出，测试里等价重算定位 history 目录）
  function dirForKey(fileKey: string): string {
    const slug = createHash('sha256').update(fileKey, 'utf-8').digest('hex').slice(0, 32);
    return join(ORU_DIR, 'users', 'local-user', 'history', slug);
  }

  it('manifest 损坏 → 隔离整个 history 目录（连快照配套保留），而非按无历史重建把版本引用丢光', async () => {
    const key = freshKey();
    // 先建真实历史：两版快照 + manifest
    await FH.snapshot(key, 'initial', 'v0');
    const ref1 = await FH.snapshot(key, 'manual', 'v1');
    const dir = dirForKey(key);
    const manifestBefore = await fs.readFile(join(dir, 'manifest.json'), 'utf-8');
    expect(manifestBefore).toContain(ref1!.id);

    // 弄坏 manifest（半写坏）
    await fs.writeFile(join(dir, 'manifest.json'), '{"version":1,"snapshots":[', 'utf-8');

    // 读到损坏 → 隔离整个目录，当前 key 视作无历史（list 空、lastHash null）
    expect(await FH.list(key)).toEqual([]);
    expect(await FH.lastHash(key)).toBeNull();

    // 隔离 sidecar：`<dir>.corrupt-<ts>` 里 manifest 与快照文件配套保留，可人工恢复
    const parent = join(ORU_DIR, 'users', 'local-user', 'history');
    const slug = dir.slice(parent.length + 1);
    const sidecars = (await fs.readdir(parent)).filter((n) => n.startsWith(`${slug}.corrupt-`));
    expect(sidecars).toHaveLength(1);
    const sidecarDir = join(parent, sidecars[0]);
    expect(await fs.readFile(join(sidecarDir, 'manifest.json'), 'utf-8')).toBe(
      '{"version":1,"snapshots":[',
    );
    // 快照内容文件随目录一并保全（不沦为会被 nextId 覆盖的孤儿）
    expect(await fs.readFile(join(sidecarDir, 'snapshots', ref1!.id), 'utf-8')).toBe('v1');

    // 隔离后从空重建：新 snapshot 落全新目录，与 sidecar 互不干扰
    const ref2 = await FH.snapshot(key, 'manual', 'fresh-start');
    expect(ref2).not.toBeNull();
    expect(await FH.restore(key, ref2!.id)).toBe('fresh-start');
  });
});

describe('baseline 碰撞回归（旧 C-3，§11.8）', () => {
  it('两 caller baseline 相同、中间版本——中间版本仍进历史、可 restore', async () => {
    const key = freshKey();
    await safeWriteAsync(key, 'A'); // 磁盘初版 A（未进历史）

    // caller1 基于 A 写 B；caller2 基于 A 写 C。统一 workfile 锁串行化，判定只看 lastHash 不看 baseline
    await guardedWrite(key, 'manual', 'B');
    await guardedWrite(key, 'ai', 'C');

    expect(await fs.readFile(key, 'utf-8')).toBe('C'); // 磁盘 last-writer-wins
    const snaps = await FH.list(key);
    const contents = await Promise.all(snaps.map((s) => FH.restore(key, s.id)));
    // A（初版）和 B（被 C 覆盖的中间版）都必须能找回——中间版本不漏
    expect(contents).toContain('A');
    expect(contents).toContain('B');
  });

  it('三路并发同一文件，Oru 内各版都不丢（§11.11 Oru 内并发不丢）', async () => {
    const key = freshKey();
    await safeWriteAsync(key, 'base');
    // 三个写者并发抢同一 workfile 锁，串行落盘；每个被覆盖前的版本都该进历史
    await Promise.all([
      guardedWrite(key, 'manual', 'user-1'),
      guardedWrite(key, 'ai', 'ai-1'),
      guardedWrite(key, 'manual', 'user-2'),
    ]);
    const snaps = await FH.list(key);
    const contents = await Promise.all(snaps.map((s) => FH.restore(key, s.id)));
    // base + 三次写入里被后来者覆盖掉的中间版，都应能找回；最终磁盘版是三者之一
    expect(contents).toContain('base');
    const finalDisk = await fs.readFile(key, 'utf-8');
    expect(['user-1', 'ai-1', 'user-2']).toContain(finalDisk);
    // 不丢断言：被覆盖的版本数 = 写入次数 - 1（最终版仍在磁盘，其余都该在历史里）
    const written = ['user-1', 'ai-1', 'user-2'];
    const overwritten = written.filter((w) => w !== finalDisk);
    for (const v of overwritten) expect(contents).toContain(v);
  });
});

describe('大文件降频（§11.12）', () => {
  it('大文件多次快照：条数被更小的封顶压住、最新版可完整 restore', async () => {
    const key = freshKey();
    const big = 'x'.repeat(FH.LARGE_FILE_BYTES + 10); // 超大文件阈值
    for (let i = 0; i < FH.MAX_PER_FILE_LARGE + 15; i++) {
      await FH.snapshot(key, 'overwrite-guard', big + i); // 每次内容不同
    }
    const all = await FH.list(key);
    expect(all.length).toBeLessThanOrEqual(FH.MAX_PER_FILE_LARGE); // 大文件用更激进封顶
    const latest = all[all.length - 1];
    expect(await FH.restore(key, latest.id)).toBe(big + (FH.MAX_PER_FILE_LARGE + 14)); // 最新版完整
  });
});

describe('历史列表去噪（listForUser 隐藏 overwrite-guard，§4.1–4.3）', () => {
  it('listForUser 只回五类可见版本、不含任何 overwrite-guard；list 仍全量（§4.1）', async () => {
    const key = freshKey();
    // 混合存入六类：前五类可见 + overwrite-guard 内部兜底
    await FH.snapshot(key, 'initial', 'c-initial');
    await FH.snapshot(key, 'overwrite-guard', 'c-guard-1');
    await FH.snapshot(key, 'ai', 'c-ai');
    await FH.snapshot(key, 'overwrite-guard', 'c-guard-2');
    await FH.snapshot(key, 'periodic', 'c-periodic');
    await FH.snapshot(key, 'manual', 'c-manual');
    await FH.snapshot(key, 'pre-restore', 'c-pre-restore');

    const visible = await FH.listForUser(key);
    expect(visible.map((s) => s.kind).sort()).toEqual(
      ['ai', 'initial', 'manual', 'periodic', 'pre-restore'],
    );
    // 用户入口封干净：listForUser 结果里不含任何 overwrite-guard
    expect(visible.some((s) => s.kind === 'overwrite-guard')).toBe(false);

    // list 仍全量：含两条 overwrite-guard
    const all = await FH.list(key);
    expect(all.filter((s) => s.kind === 'overwrite-guard')).toHaveLength(2);
    expect(all).toHaveLength(7);
  });

  it('连续落盘制造 N 条 overwrite-guard：后台全留、可见列表不随 N 增长（§4.2）', async () => {
    const key = freshKey();
    await safeWriteAsync(key, 'base'); // 磁盘初版（未进历史）
    const N = 8; // 远小于 MAX_PER_FILE_LARGE(30)，不触发 GC 截断，故"N 条全留"是纯留存断言
    // 每次 guardedWrite 先把磁盘当前版兜成 overwrite-guard，再写新版（kind=periodic 视为节奏锚）
    // 首次写时磁盘=base 兜一条 guard；之后每次再兜上一版 → 共 N 条 guard
    for (let i = 0; i < N; i++) {
      await guardedWrite(key, 'overwrite-guard', `edit-${i}`);
    }

    const all = await FH.list(key);
    const guards = all.filter((s) => s.kind === 'overwrite-guard');
    expect(guards).toHaveLength(N); // ① 后台留存未变，N 条全在

    const visible = await FH.listForUser(key);
    expect(visible).toHaveLength(0); // ② 全是 guard → 可见列表收敛为空，不随 N 刷屏
  });

  it('overwrite-guard 仍参与 GC，但底层 restore/可见性两层口径分离（§4.3）', async () => {
    const key = freshKey();
    // 存一条 guard，记下 id；它不该出现在 listForUser，但底层 restore 仍能取回
    const guardRef = await FH.snapshot(key, 'overwrite-guard', 'guarded-content');
    await FH.snapshot(key, 'manual', 'visible-content');

    const visible = await FH.listForUser(key);
    expect(visible.some((s) => s.id === guardRef!.id)).toBe(false); // 用户入口取不到该 id
    // 底层找回能力不变：给定 snapshotId 仍能取回未被 GC 的 guard 内容
    expect(await FH.restore(key, guardRef!.id)).toBe('guarded-content');
  });
});

describe('periodic 去重基线（编辑后撤回不留「什么都没变」的幽灵自动保存）', () => {
  it('periodic 与最近可见版字节相同则 no-op，即便 lastHash 已被隐藏的 overwrite-guard 推走', async () => {
    const key = freshKey();
    // 真实触发：A 自动保存 → 编辑成 B 落盘（B 在被撤回覆盖前兜成 overwrite-guard）→ 撤回成 A。
    // 此刻 lastHash 指向隐藏版 B，但磁盘 = 最近可见版 A，下一次周期取样不该再写一条 A。
    const a = await FH.snapshot(key, 'periodic', 'A');
    expect(a).not.toBeNull();
    await FH.snapshot(key, 'overwrite-guard', 'B'); // 中间版兜底（隐藏），lastHash → B
    const phantom = await FH.snapshot(key, 'periodic', 'A'); // 撤回后取样：与可见版 A 相同
    expect(phantom).toBeNull(); // 不再写幽灵自动保存

    // 可见列表只有一条 A；隐藏的中间版 B 仍在（不丢）
    const visible = await FH.listForUser(key);
    expect(visible.filter((s) => s.kind === 'periodic')).toHaveLength(1);
    const contents = await Promise.all((await FH.list(key)).map((s) => FH.restore(key, s.id)));
    expect(contents).toContain('B');
  });

  it('无任何可见快照时首次 periodic 正常写入（lastVisibleHash=null 不误判 no-op）', async () => {
    const key = freshKey();
    const ref = await FH.snapshot(key, 'periodic', 'first');
    expect(ref).not.toBeNull(); // null 基线下 hash !== null → 应写入
  });

  it('periodic 与隐藏版相同但与可见版不同 → 仍写（给当前磁盘态一个可见锚）', async () => {
    const key = freshKey();
    await FH.snapshot(key, 'periodic', 'A'); // 可见 A
    await FH.snapshot(key, 'overwrite-guard', 'B'); // 隐藏 B，lastHash = B
    const ref = await FH.snapshot(key, 'periodic', 'B'); // 磁盘当前 = B，可见版还是 A
    expect(ref).not.toBeNull(); // B 与最近可见版 A 不同 → 写，给 B 一个可见锚
    expect((await FH.listForUser(key)).filter((s) => s.kind === 'periodic')).toHaveLength(2);
  });
});

describe('并发 snapshot 串行化', () => {
  it('并发追加无重复 id、无丢条（§11.1）', async () => {
    const key = freshKey();
    const refs = await Promise.all(
      Array.from({ length: 20 }, (_, i) => FH.snapshot(key, 'periodic', `c${i}`)),
    );
    const ids = refs.filter((r): r is NonNullable<typeof r> => r !== null).map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // id 不重复
    const list = await FH.list(key);
    expect(list.length).toBe(20); // 20 个不同内容全部入库，无丢
  });
});

describe('deck kind 扩展 + GC 保护（项目B 第一期 Task1）', () => {
  it('snapshot 接受 deck 事件 kind，list 回的 ref.kind 原样', async () => {
    const key = freshKey();
    const ref = await FH.snapshot(key, 'protective', 'before-html');
    expect(ref).not.toBeNull();
    const all = await FH.list(key);
    expect(all[0].kind).toBe('protective');
    // batch/inline/reorder 也都接受（编译期超集 + 运行期落库）
    await FH.snapshot(key, 'batch', 'b1');
    await FH.snapshot(key, 'inline', 'i1');
    await FH.snapshot(key, 'reorder', 'r1');
    const kinds = (await FH.list(key)).map((s) => s.kind);
    expect(kinds).toEqual(['protective', 'batch', 'inline', 'reorder']);
  });

  it('protective 进 PROTECTED_KINDS：封顶淘汰时优先留，不被 periodic 挤掉', async () => {
    // 用大文件路径（cap=MAX_PER_FILE_LARGE=30）少迭代验同一结论，避免 220 次写在并发下超时
    const big = (t: string) => 'x'.repeat(FH.LARGE_FILE_BYTES + 1) + t;
    const key = freshKey();
    // 先存一条 protective（最旧），再用 periodic 灌爆封顶——protective 应被保住、periodic 被先淘
    const prot = await FH.snapshot(key, 'protective', big('PROTECTED'));
    for (let i = 0; i < FH.MAX_PER_FILE_LARGE + 5; i++) {
      await FH.snapshot(key, 'periodic', big(`p${i}`));
    }
    const all = await FH.list(key);
    expect(all.length).toBeLessThanOrEqual(FH.MAX_PER_FILE_LARGE);
    // protective 最旧但受保护——仍能 restore 到原内容
    expect(await FH.restore(key, prot!.id)).toBe(big('PROTECTED'));
  });
});

describe('commitSnapshot 必出 ref + setRetention/GC 豁免（项目B 第一期 Task3）', () => {
  // 直接改盘上 manifest 造按龄场景（不 mock 时钟，避免干扰真实 fs I/O）
  async function manifestDir(key: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    const { historyDir } = await import('../../electron/main/runtime/paths');
    const { getCurrentOwnerId } = await import('../../electron/main/identity/getCurrentOwnerId');
    const slug = createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, 32);
    return join(historyDir(getCurrentOwnerId()), slug);
  }
  async function backdateAll(key: string, ms: number): Promise<void> {
    const dir = await manifestDir(key);
    const p = join(dir, 'manifest.json');
    const store = JSON.parse(await fs.readFile(p, 'utf-8'));
    for (const s of store.snapshots) s.createdAt -= ms;
    await fs.writeFile(p, JSON.stringify(store, null, 2));
  }
  const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;

  it('commitSnapshot：内容未变返回现存最新 ref（非 null），内容变了返回新 ref', async () => {
    const key = freshKey();
    const r1 = await FH.commitSnapshot(key, 'ai', 'x');
    expect(r1).not.toBeNull();
    const r2 = await FH.commitSnapshot(key, 'ai', 'x'); // 内容没变
    expect(r2.id).toBe(r1.id); // 复用同一版语义正确（before/after 不落空）
    expect(await FH.list(key)).toHaveLength(1); // 不重复存
    const r3 = await FH.commitSnapshot(key, 'ai', 'y'); // 内容变了
    expect(r3.id).not.toBe(r1.id);
    expect(await FH.list(key)).toHaveLength(2);
  });

  it('setRetention retainAll：deck 文件不按龄删（md/csv 默认仍按龄删）', async () => {
    const exempt = freshKey();
    await FH.setRetention(exempt, { retainAll: true }); // 先设（必须在 snapshot 之前）
    await FH.snapshot(exempt, 'periodic', 'a');
    await FH.snapshot(exempt, 'periodic', 'b');
    await backdateAll(exempt, EIGHT_DAYS); // a/b 变成 8 天前
    await FH.commitSnapshot(exempt, 'ai', 'c'); // 触发 GC
    const ids = (await FH.list(exempt)).map((s) => s.id);
    expect(ids.length).toBe(3); // retainAll → a/b 不被按龄删

    // 对照：默认（无 retainAll）按龄删——非最新的旧 periodic 被淘
    const def = freshKey();
    await FH.snapshot(def, 'periodic', 'a');
    await FH.snapshot(def, 'periodic', 'b');
    await backdateAll(def, EIGHT_DAYS);
    await FH.snapshot(def, 'periodic', 'c'); // 触发 GC，c 是最新（豁免）
    const defContents = await Promise.all((await FH.list(def)).map((s) => FH.restore(def, s.id)));
    expect(defContents).toContain('c'); // 最新永远在
    expect(defContents).not.toContain('a'); // 8 天前的被按龄删
  });

  it('setRetention retainAll：deck 文件也不按封顶删（>cap 个版本一条不丢，承重生死线-2）', async () => {
    // 用大文件路径（>512KB → cap=MAX_PER_FILE_LARGE=30）少迭代验同一结论，避免 221 次写超时
    const big = (tag: string) => 'x'.repeat(FH.LARGE_FILE_BYTES + 1) + tag;
    const key = freshKey();
    await FH.setRetention(key, { retainAll: true });
    const first = await FH.snapshot(key, 'periodic', big('OLDEST')); // 最旧
    for (let i = 0; i < FH.MAX_PER_FILE_LARGE + 5; i++) {
      await FH.snapshot(key, 'periodic', big(`p${i}`)); // 灌爆大文件封顶
    }
    expect((await FH.list(key)).length).toBe(FH.MAX_PER_FILE_LARGE + 6); // 一条不丢（含最旧）
    expect(await FH.restore(key, first!.id)).toBe(big('OLDEST')); // 最旧仍能 restore

    // 对照：默认无 retainAll，大文件封顶生效（淘到 ≤30）
    const def = freshKey();
    for (let i = 0; i < FH.MAX_PER_FILE_LARGE + 5; i++) await FH.snapshot(def, 'periodic', big(`d${i}`));
    expect((await FH.list(def)).length).toBeLessThanOrEqual(FH.MAX_PER_FILE_LARGE);
  });
});

describe('按-id pin：被引用版本免于 GC（项目B 第三期 Task11.5，裁定 A）', () => {
  // html 周期模型不能 retainAll，被引用的 before/after 靠按-id pin 免于 GC（生死线-3）。
  // 承重：gcInPlace 按龄段现不看 PROTECTED_KINDS，故用 periodic（非保护 kind）隔离验证 pin 本身。
  async function manifestPath(key: string): Promise<string> {
    const { createHash } = await import('node:crypto');
    const { historyDir } = await import('../../electron/main/runtime/paths');
    const { getCurrentOwnerId } = await import('../../electron/main/identity/getCurrentOwnerId');
    const slug = createHash('sha256').update(key, 'utf-8').digest('hex').slice(0, 32);
    return join(historyDir(getCurrentOwnerId()), slug, 'manifest.json');
  }
  async function backdateAll(key: string, ms: number): Promise<void> {
    const p = await manifestPath(key);
    const store = JSON.parse(await fs.readFile(p, 'utf-8'));
    for (const s of store.snapshots) s.createdAt -= ms;
    await fs.writeFile(p, JSON.stringify(store, null, 2));
  }
  const EIGHT_DAYS = 8 * 24 * 60 * 60 * 1000;

  it('pin 防按龄删：pinned 的旧版不被淘，未 pin 的旧版照淘', async () => {
    const key = freshKey();
    const before = await FH.snapshot(key, 'periodic', 'BEFORE'); // 将被 pin
    const other = await FH.snapshot(key, 'periodic', 'OTHER'); // 不 pin
    await FH.pin(key, [before!.id]);
    await backdateAll(key, EIGHT_DAYS); // 全变 8 天前
    await FH.commitSnapshot(key, 'ai', 'NEWEST'); // 触发 GC
    const ids = (await FH.list(key)).map((s) => s.id);
    expect(ids).toContain(before!.id); // pinned 留
    expect(ids).not.toContain(other!.id); // 未 pin 的旧 periodic 被按龄删
  });

  it('pin 防封顶删：pinned 的最旧版灌爆 cap 仍在', async () => {
    const big = (t: string) => 'x'.repeat(FH.LARGE_FILE_BYTES + 1) + t;
    const key = freshKey();
    const oldest = await FH.snapshot(key, 'periodic', big('OLDEST'));
    await FH.pin(key, [oldest!.id]);
    for (let i = 0; i < FH.MAX_PER_FILE_LARGE + 5; i++) await FH.snapshot(key, 'periodic', big(`p${i}`));
    expect(await FH.restore(key, oldest!.id)).toBe(big('OLDEST')); // pinned 最旧仍 restore
  });

  it('unpin 后回归普通 GC：解 pin 的旧版可被淘', async () => {
    const key = freshKey();
    const v = await FH.snapshot(key, 'periodic', 'V');
    await FH.snapshot(key, 'periodic', 'KEEP-NEWEST');
    await FH.pin(key, [v!.id]);
    await FH.unpin(key, [v!.id]);
    await backdateAll(key, EIGHT_DAYS);
    await FH.commitSnapshot(key, 'ai', 'NEWEST');
    const ids = (await FH.list(key)).map((s) => s.id);
    expect(ids).not.toContain(v!.id); // unpin 后按龄删
  });

  it('pinned 落盘持久（崩溃存活，不靠内存）', async () => {
    const key = freshKey();
    const v = await FH.snapshot(key, 'periodic', 'V');
    await FH.pin(key, [v!.id]);
    const store = JSON.parse(await fs.readFile(await manifestPath(key), 'utf-8'));
    expect(store.pinned).toContain(v!.id);
  });
});

describe('可见 mark 撞上隐藏 overwrite-guard 仍记录（档案「完成」留底丢失根因）', () => {
  // 病根：commitWorkfileWrite 落盘时 guardOverwrite 先把磁盘当前版兜成隐藏 overwrite-guard 并把 lastHash
  // 推到该内容；紧随其后同字节的可见 mark 若按 lastHash 去重就被吞成 null——里程碑静默消失。改按 lastVisibleHash
  // 去重后，撞隐藏版仍记录，只有撞「最近一个可见版」才当真冗余吞掉。
  it('mark 内容 === 刚兜的隐藏 overwrite-guard 时，仍落一条可见快照', async () => {
    const key = freshKey();
    await FH.snapshot(key, 'manual', 'A'); // 可见基线（最近可见版 = A）
    await FH.snapshot(key, 'overwrite-guard', 'B'); // 模拟 guardOverwrite 兜磁盘版 B、lastHash→B（隐藏）
    const ref = await FH.snapshot(key, 'manual', 'B'); // 点「完成」：与磁盘同字节 B
    expect(ref).not.toBeNull(); // 旧实现按 lastHash=B 去重会得 null，里程碑丢失
    const visible = await FH.listForUser(key);
    expect(visible.filter((s) => s.kind === 'manual').length).toBe(2);
  });

  it('mark 内容 === 最近一个可见版时，才当真冗余去重（不留幽灵条目）', async () => {
    const key = freshKey();
    await FH.snapshot(key, 'manual', 'A'); // 最近可见版 = A
    const dup = await FH.snapshot(key, 'manual', 'A'); // 同字节、无新可恢复信息
    expect(dup).toBeNull();
  });
});
