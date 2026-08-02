/**
 * FileHistory —— md/csv 工作文件的通用快照层（「自动留底找回」的内核）。
 *
 * 只管三件所有文件类型真正共享的事：**快照文件存储 + GC + 最新快照内容 hash（单一真相源）**。
 * deck 的指针语义（currentVersion / checkout / changedPages / undo barrier）是 deck 承重结构，
 * 不在这层——deck 在自己的 history.ts 里在「快照之上」自管（详技术设计 §2.1）。
 *
 * 「不丢」判定靠 lastHash 单一真相源，不退回 per-caller baseline（消除旧 C-3 baseline 碰撞漏抓）：
 * 落盘临界区里先 `snapshot('overwrite-guard', 磁盘当前版)`——内部判定 hash(cur) === lastHash 就 no-op，
 * 否则说明 cur 是「还没进过历史的版本」（别人在我之前落、我没见过的），先存进历史再让我覆盖。
 * 任何曾落到磁盘的版本，在被下一次覆盖前都会被下一个落盘者读到并存档，故不丢。
 *
 * 并发纪律（详技术设计 §2.2）：
 *  - 每个 fileKey 一把 `history:`+fileKey 小锁（复用 runExclusive），串行化「读 lastHash → 比对 →
 *    写快照 + 更新 lastHash + GC」整段 RMW；no-op 判定与写在同一小锁内，杜绝 TOCTOU。
 *  - GC 在小锁内**直接调内部函数**，禁止再 runExclusive('history:'+fileKey) 自排队（锁内等自己＝自死锁）。
 *  - 锁方向单向不变量：本模块**禁止内部调 runExclusive(workfilePath)**（它不写工作文件、不抢工作文件锁），
 *    保证「workfile 锁 → history 小锁」单向，无交叉死锁。
 *
 * 存储：~/.oru/users/<owner>/history/<sha256(fileKey)[:32]>/，内含 manifest.json + snapshots/<id>。
 * 快照一律全量（MVP 不做增量 diff）；大文件靠 GC 降频/缩短保留压存储（详技术设计 §2.3）。
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { FileSnapshotKind, FileSnapshotRef } from '@shared/types';
import { safeWriteAsync } from './safeWrite';
import { runExclusive } from './runExclusive';
import { quarantineCorrupt } from '../runtime/storageCorruption';
import { historyDir, fileKeySlug } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';

// 快照类型/元数据上收到 shared/types（渲染端历史窗口复用），这里只 re-export 方便本目录引用
export type SnapshotKind = FileSnapshotKind;
export type SnapshotRef = FileSnapshotRef;

/**
 * S28（G92）：里程碑版本到期归档时的旁路通知钩子——本模块不依赖通知中心（保持「不写工作文件、不抢锁、
 * 无外部依赖」的纯净），主进程装配时注入把归档事件接进系统信号（feeds.ts）。未注入（测试/早于装配）静默。
 */
type ArchivalListener = (fileKey: string, archived: SnapshotRef[]) => void;
let archivalListener: ArchivalListener | null = null;
export function setArchivalListener(fn: ArchivalListener | null): void {
  archivalListener = fn;
}

type HistoryStore = {
  version: 1;
  fileKey: string;
  /** 最新快照的内容 hash——单一真相源；no-op 判定与不丢判定都只看它 */
  lastHash: string | null;
  /** 时间序递增 */
  snapshots: SnapshotRef[];
  /**
   * 「全部保留、绝不自动淘汰」——调用方声明此文件的每个版本都是显式里程碑、价值不随时间衰减，
   * 既不按龄删也不按封顶删（项目B：deck 用它）。第一性 + 零回退：旧 deck `.history` 系统从不
   * 淘汰任何 commit 过的版本，按龄/封顶都是 md/csv 周期取样底的机制，强加给 deck 即新引入回退、
   * 且 >cap 个版本的 deck 迁移时会被封顶删字节→旧版悬空（生死线-2/3）。缺省 undefined=正常 GC。
   * 注：deck 历史因此无存储上限（与旧 .history 同），属已知的延后治理项（须 reference-aware，不在本期）。
   */
  retainAll?: boolean;
  /**
   * S28（G91）：最新磁盘版由哪支笔写下（'user'=用户落盘、'ai'=AI 落盘）。落盘临界区 guardOverwrite 据它判
   * 「换笔」——覆盖者与写下当前磁盘版的那支笔不同时，被覆盖版打可见的 'handoff' 标（时间轴上认得出、点得回）；
   * 同笔连续覆盖打隐藏的 'overwrite-guard'。落盘（崩溃存活），null=尚无已知作者（新文件/迁移前）。
   */
  lastAuthor?: 'user' | 'ai';
  /**
   * 按-id pin（项目B 第三期，裁定 A）：被引用的版本 id 在引用存续期间免于 GC（按龄+封顶都跳过）。
   * 落盘（崩溃存活），不靠内存。用途：html 周期模型不能 retainAll，提交组的 before/after 靠它免于淘汰
   * （生死线-3）；deck 走 retainAll 时对它冗余无害。提交层 pin/unpin、reconcile 据中断记录重建。
   */
  pinned?: string[];
};

// ─── GC 参数 ───────────────────────────────────────────────────
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** 保留窗口：7 天 */
export const MAX_AGE_MS = 7 * 24 * HOUR_MS;
// 下面三个封顶/阈值为初值拍定（无实测依据）——大文件每张全量快照都贵故封顶更小，方向定性正确，
// 但 200 / 30 / 512KB 的具体数待观察真实 .history 体积后调（技术设计 §2.3 大文件靠降频，不上增量 diff）。
/** 普通文件单文件封顶快照数 */
export const MAX_PER_FILE = 200;
/** 大文件单文件封顶 */
export const MAX_PER_FILE_LARGE = 30;
/** 判「大文件」的内容字节阈值（按最新快照大小判） */
export const LARGE_FILE_BYTES = 512 * 1024;
/** 事件类快照不参与「间隔稀释」——它们各自承载语义（手动留底 / AI 改动边界 / 纳管底版 / restore 前留底） */
const PROTECTED_KINDS: ReadonlySet<SnapshotKind> = new Set<SnapshotKind>([
  'manual',
  'ai',
  'initial',
  'pre-restore',
  'handoff', // S28：换笔覆盖前留底，承载「找回 AI 改动前 / AI 刚写的版本」承诺，按里程碑保留
  'discarded', // S27：弃写降级留底，承载「可找回」承诺、抗封顶稀释
  'conflict-version', // S29：冲突卡双方版本，背「可找回」承诺、按里程碑保留
  'conflict-losing', // S29：冲突落选版，同上
  // deck 事件类版本都是用户显式 commit 的里程碑（项目B 裁定 A），抗封顶稀释
  'protective',
  'batch',
  'inline',
  'reorder',
]);

// 用户可后悔的版本类型——每一条都对应「我能说清为什么想回到这」的事件点。overwrite-guard 是每次落盘
// （≤0.8s）都兜的高频内部安全网，单条无此意义，故不在其列。与 PROTECTED_KINDS 正交：前者管「给谁看」、
// 后者管「GC 时谁优先留」，overwrite-guard 不可见但仍是 GC 承重记录，正是两集合差异的意义。
const USER_VISIBLE_KINDS: ReadonlySet<SnapshotKind> = new Set<SnapshotKind>([
  'manual',
  'ai',
  'initial',
  'pre-restore',
  'periodic',
  'handoff', // S28（G91）：换笔覆盖前留底对用户可见——「你的最后一版」/「AI 刚写的版本」在时间轴上点得回
  'discarded', // S27：弃写降级留底对用户可见（历史窗口里点得回），与 S3 节点「弃写降级」口对齐
  'conflict-version', // S29（G90）：冲突卡双方版本对用户可见可点回
  'conflict-losing', // S29（G90）：冲突落选版对用户可见可点回
]);

// ─── 寻址 / 读写 ────────────────────────────────────────────────

function hashOf(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex');
}

/** 最近一个用户可见快照的内容 hash（所有可见 kind 的去重基线）；无可见版返回 null。 */
function lastVisibleHash(store: HistoryStore): string | null {
  for (let i = store.snapshots.length - 1; i >= 0; i--) {
    if (USER_VISIBLE_KINDS.has(store.snapshots[i].kind)) return store.snapshots[i].hash;
  }
  return null;
}

function dirFor(fileKey: string): string {
  return join(historyDir(getCurrentOwnerId()), fileKeySlug(fileKey));
}

function snapshotFile(dir: string, id: string): string {
  return join(dir, 'snapshots', id);
}

async function readStore(dir: string): Promise<HistoryStore | null> {
  const raw = await fs.readFile(join(dir, 'manifest.json'), 'utf-8').catch(() => null);
  if (raw === null) return null; // 不存在 / 读抖动——正常无历史，不隔离
  try {
    const parsed = JSON.parse(raw) as HistoryStore;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.snapshots)) return parsed;
    // 解析出来但结构非法（版本不符 / 字段坏）——按损坏处理，落到下方隔离
    throw new Error('fileHistory manifest 结构非法');
  } catch {
    // manifest 损坏：隔离整个 history 目录（连 snapshots/ 一并 sidecar，manifest↔快照文件配套保留、
    // 可恢复），而非「按无历史重建」把版本引用丢光、快照沦为会被 nextId 覆盖的孤儿（§Deg 隔离保留）。
    // 隔离后本文件历史从空重建，下一次 snapshot 落全新目录，损坏字节已进 sidecar。
    await quarantineCorrupt(dir, 'fileHistory/manifest');
    return null;
  }
}

async function writeStore(dir: string, store: HistoryStore): Promise<void> {
  await safeWriteAsync(join(dir, 'manifest.json'), JSON.stringify(store, null, 2));
}

function nextId(snapshots: SnapshotRef[]): string {
  // 同 deck nextVersionId：取数字最大者 +1，不用 length（未来允许删除版本时仍单调）
  const max = snapshots
    .map((s) => parseInt(s.id.replace(/^s/, ''), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `s${String(max + 1).padStart(3, '0')}`;
}

// ─── 对外接口 ────────────────────────────────────────────────────

/**
 * 追加一个快照。**在 history 小锁内**：hash(content) === lastHash 则 no-op 返回 null（内容没变，
 * 不存重复）；否则写快照文件 + 追加 ref + 更新 lastHash + GC，返回 ref。
 *
 * content 由调用方传入；本函数只读写 history 目录，绝不碰工作文件、不抢工作文件锁。
 */
export async function snapshot(
  fileKey: string,
  kind: SnapshotKind,
  content: string,
): Promise<SnapshotRef | null> {
  return runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    const store = (await readStore(dir)) ?? emptyStore(fileKey);
    const hash = hashOf(content);
    // no-op 去重基线分两路（判定与写同锁内，无 TOCTOU），按「这版给不给用户看」分：
    //  - 隐藏兜底（overwrite-guard）看 lastHash 单一真相源——承重「不丢」，任何未进历史的版本都要兜。
    //  - **所有用户可见 kind**（manual/ai/periodic/discarded/pre-restore…）只和最近一个**可见**版去重。
    //    根因：guardOverwrite 会把「磁盘当前版」兜成隐藏 overwrite-guard 并把 lastHash 推到它，于是紧随
    //    其后同内容的可见 mark 若按 lastHash 去重就被吞成 null——里程碑静默消失（档案「完成」留底丢失的病根：
    //    autosave 先把最终内容落定磁盘 → 点完成的 manual 与磁盘同字节 → guardOverwrite 推 lastHash → manual 被去重）。
    //    按 lastVisibleHash 去重只吞「与最近可见版同字节」的真冗余（那版本身就是可恢复的还原点，不丢信息），
    //    撞上更旧的可见版或隐藏版都照记——既堵幽灵条目，又保住每个可见事件。lastVisibleHash 仅指最近一个可见版，
    //    故「内容撞上某个更旧可见版也要记录」的诉求同样满足。
    const dedupHash = USER_VISIBLE_KINDS.has(kind) ? lastVisibleHash(store) : store.lastHash;
    if (hash === dedupHash) return null;
    return writeSnapshotLocked(fileKey, dir, store, kind, content, hash);
  });
}

/**
 * 「取/建此内容的版本 ref」——**永远返回 ref，绝不返 null**（项目B 裁定 B，前置阻塞#6）。
 * 与 snapshot 的唯一差异：内容未变（hash===lastHash）时返回**现存的那一版 ref**（其 hash===lastHash，
 * 即最新一条），而非 null。deck commit 是「语义事件边界」（protective/ai），必须拿到一个 id 当
 * before/after——内容确实没变时复用同一版 id 语义正确。周期取样仍走 snapshot（去重返 null）。
 */
export async function commitSnapshot(
  fileKey: string,
  kind: SnapshotKind,
  content: string,
): Promise<SnapshotRef> {
  return runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    const store = (await readStore(dir)) ?? emptyStore(fileKey);
    const hash = hashOf(content);
    if (hash === store.lastHash && store.snapshots.length > 0) {
      // 内容未变——复用最新一条（lastHash 恒为最新快照的 hash，同锁内维护的不变量）。
      // 不从全表搜 hash：lastHash===最新一条是硬不变量，直接取尾，找不到说明 store 损坏（下面会落一版兜底，不丢内容）。
      return store.snapshots[store.snapshots.length - 1];
    }
    return writeSnapshotLocked(fileKey, dir, store, kind, content, hash);
  });
}

/**
 * S29（G90）冲突卡开卡：把双方版本各存一版进历史打 'conflict-version' 标（对用户可见、按里程碑保留、
 * 抗稀释）——防「收起时才入库」的数小时窗口：卡上未落盘的 mine 一旦崩溃即丢。返回两版 snapshot id，
 * 供收起时按出口 re-tag（二选一给落选那份补 'conflict-losing'）。
 * mine 先存、theirs 后存：theirs == 当前磁盘，末尾存 theirs 让 lastHash 收在磁盘现状上（与 guardOverwrite
 * 单一真相源一致，不致下次覆盖误兜）。同段冲突保证 mine≠theirs，两版各写一条、互不去重。
 */
export async function snapshotConflictPair(
  fileKey: string,
  mine: string,
  theirs: string,
): Promise<{ mineId: string; theirsId: string }> {
  return runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    const store = (await readStore(dir)) ?? emptyStore(fileKey);
    const mineRef = await writeSnapshotLocked(fileKey, dir, store, 'conflict-version', mine, hashOf(mine));
    const theirsRef = await writeSnapshotLocked(fileKey, dir, store, 'conflict-version', theirs, hashOf(theirs));
    return { mineId: mineRef.id, theirsId: theirsRef.id };
  });
}

/**
 * S29（G90）冲突卡收起补标：把某快照的 kind 改成 newKind（二选一时给落选那份从 'conflict-version' 改判
 * 'conflict-losing'；手动拼合双方都留 'conflict-version'、无需调用）。只动 manifest 里那条 ref 的 kind、
 * 不碰内容文件。目标不存在则 no-op——主要为开卡簿记失败（渲染端拿到空 id）这条真实路径兜底；conflict-version
 * 进 PROTECTED_KINDS 抗 GC，秒级到分钟级的卡生命周期内正常不会被淘汰。
 */
export async function retagSnapshot(fileKey: string, snapshotId: string, newKind: SnapshotKind): Promise<void> {
  await runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    const store = await readStore(dir);
    if (!store) return;
    const ref = store.snapshots.find((s) => s.id === snapshotId);
    if (!ref) return;
    ref.kind = newKind;
    await writeStore(dir, store);
  });
}

/**
 * S28（G91）落盘临界区专用：覆盖磁盘当前版 `cur` 前把它兜进历史，并按「换笔」定其可见性。
 *  - `cur===null`（新建，无前版）：不兜，只把 lastAuthor 记成这支笔（供下次覆盖判换笔）。
 *  - `cur` 已在历史（hash===lastHash）：不重复兜，只推进 lastAuthor。
 *  - `cur` 未进历史：兜一版——`by` 与写下 `cur` 的那支笔（store.lastAuthor）不同 = 换笔，打**可见**的
 *    'handoff' 标（「你的最后一版」/「AI 刚写的版本」时间轴上认得出、点得回）；同笔连续覆盖打**隐藏**的
 *    'overwrite-guard'（高频兜底、承重不丢，但不上时间轴）。记完把 lastAuthor 推进到 `by`（我这支笔成为
 *    最新磁盘版的作者）。取代原先无差别的 `snapshot(key,'overwrite-guard',cur)`。
 * 只读写 history 目录、不碰工作文件、不抢工作文件锁（与 snapshot 同纪律）。
 */
export async function guardOverwrite(
  fileKey: string,
  cur: string | null,
  by: 'user' | 'ai',
): Promise<void> {
  await runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    const store = (await readStore(dir)) ?? emptyStore(fileKey);
    if (cur !== null) {
      const hash = hashOf(cur);
      if (hash !== store.lastHash) {
        // cur 是还没进过历史的版本（别人在我之前落、我没见过的）——覆盖前先兜进历史。
        const handoff = store.lastAuthor != null && store.lastAuthor !== by;
        // writeSnapshotLocked 会一并把 lastAuthor 推进到 by 并落盘（单次 writeStore）。
        await writeSnapshotLocked(fileKey, dir, store, handoff ? 'handoff' : 'overwrite-guard', cur, hash, {
          setLastAuthor: by,
        });
        return;
      }
    }
    // 无需在此兜底（新建无前版 / cur 已是最新历史版 / restore 已另兜 pre-restore）——仍推进 lastAuthor
    // 记下「这支笔将写下最新磁盘版」，供下次覆盖判换笔。
    store.lastAuthor = by;
    await writeStore(dir, store);
  });
}

/**
 * S28（G93）历史时间轴随改名/移动迁移：把 oldFileKey 的整条历史目录搬到 newFileKey 下（历史按内容寻址=
 * sha256(fileKey)，路径一变寻址就断）。调用方（mutate 改名/移动）在其 workfile 锁内、**成功 rename 之后**调，
 * 保证旧路径此刻无并发落盘。best-effort 语义由调用方决定（历史迁移失败不该让已成功的文件移动回滚）。
 *  - 旧路径无历史 → no-op。
 *  - 新路径已有历史（陈留孤儿：此前同路径文件被删后残留；文件移动本身已保证目标不存在同名文件）→ 先清掉再搬。
 * 只在 old 的 history 小锁内做（新路径此刻无写者）；更新 store.fileKey 保持自洽。
 */
export async function relocate(oldFileKey: string, newFileKey: string): Promise<void> {
  await runExclusive(`history:${oldFileKey}`, async () => {
    const oldDir = dirFor(oldFileKey);
    const newDir = dirFor(newFileKey);
    if (oldDir === newDir) return;
    const store = await readStore(oldDir);
    if (!store) return; // 旧路径无历史
    await fs.rm(newDir, { recursive: true, force: true }); // 清掉目标处的陈留孤儿（若有）
    store.fileKey = newFileKey;
    await writeStore(oldDir, store); // 先把新 fileKey 落到旧目录的 manifest，再整目录搬
    await fs.rename(oldDir, newDir);
  });
}

/**
 * 设置保留策略（项目B）：retainAll=true 让此文件「全部保留、绝不自动淘汰」。merge 进 store 并落盘。
 * **必须在该文件首个 snapshot 落库之前调**——否则首次 commitSnapshot 的 GC 会以 retainAll=undefined
 * 跑正常淘汰（迁移 >cap 个版本时即丢字节，承重，见 reviewer 收敛结论）。
 */
export async function setRetention(fileKey: string, opts: { retainAll?: boolean }): Promise<void> {
  await runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    const store = (await readStore(dir)) ?? emptyStore(fileKey);
    if (opts.retainAll !== undefined) store.retainAll = opts.retainAll;
    await writeStore(dir, store);
  });
}

/**
 * pin/unpin 一批快照 id（项目B 第三期，裁定 A）：pinned 的版本免于 GC（按龄+封顶都跳过），
 * 在被引用期间不丢。merge/移除进 store.pinned 并原子落盘（不跑 GC，下次 commit 自然应用）。
 * 提交层在 submit/finalize 后 pin before/after、组解散时 unpin；崩溃后据中断记录重建 pin 集（不靠内存）。
 */
export async function pin(fileKey: string, ids: string[]): Promise<void> {
  await runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    const store = (await readStore(dir)) ?? emptyStore(fileKey);
    store.pinned = [...new Set([...(store.pinned ?? []), ...ids])];
    await writeStore(dir, store);
  });
}

export async function unpin(fileKey: string, ids: string[]): Promise<void> {
  await runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    const store = await readStore(dir);
    if (!store?.pinned) return;
    const drop = new Set(ids);
    store.pinned = store.pinned.filter((id) => !drop.has(id));
    await writeStore(dir, store);
  });
}

function emptyStore(fileKey: string): HistoryStore {
  return { version: 1, fileKey, lastHash: null, snapshots: [] };
}

/**
 * 写一版新快照 + 推进 lastHash + GC（必须已在 history 小锁内、且已确认内容有变）。snapshot/commitSnapshot/
 * guardOverwrite 共用。opts.setLastAuthor：把「当前磁盘版作者」推进到这支笔（guardOverwrite 用，见其说明）。
 */
async function writeSnapshotLocked(
  fileKey: string,
  dir: string,
  store: HistoryStore,
  kind: SnapshotKind,
  content: string,
  hash: string,
  opts?: { setLastAuthor?: 'user' | 'ai' },
): Promise<SnapshotRef> {
  const id = nextId(store.snapshots);
  await safeWriteAsync(snapshotFile(dir, id), content);
  const ref: SnapshotRef = { id, createdAt: Date.now(), kind, hash, size: content.length };
  store.snapshots.push(ref);
  store.lastHash = hash; // 真相源永远指向刚写的这一版（GC 不删最新，故 lastHash 对应文件恒在）
  if (opts?.setLastAuthor) store.lastAuthor = opts.setLastAuthor;

  // GC 在锁内直接调（不再 enqueue 同链）；返回要删的 ref + 到期归档的里程碑 ref，落盘 manifest 后再删文件/发信号
  const { removed, newlyArchived } = gcInPlace(store.snapshots, store.retainAll, store.pinned);
  await writeStore(dir, store);
  await Promise.all(removed.map((r) => fs.unlink(snapshotFile(dir, r.id)).catch(() => undefined)));
  if (newlyArchived.length > 0) archivalListener?.(fileKey, newlyArchived); // G92：到期归档提示（不静默删）
  return ref;
}

/** 列出某文件的全部快照（时间序）。无历史返回空数组。GC / 极端找回 / 测试用全量视图。 */
export async function list(fileKey: string): Promise<SnapshotRef[]> {
  return runExclusive(`history:${fileKey}`, async () => {
    const store = await readStore(dirFor(fileKey));
    return store?.snapshots ?? [];
  });
}

/** 面向历史窗口的列表：只回用户可后悔版本（时间序）。overwrite-guard 不在内。 */
export async function listForUser(fileKey: string): Promise<SnapshotRef[]> {
  return (await list(fileKey)).filter((s) => USER_VISIBLE_KINDS.has(s.kind));
}

/** 取回某快照的内容（调用方在 workfile 锁内写回工作文件）。快照不存在则抛错。 */
export async function restore(fileKey: string, snapshotId: string): Promise<string> {
  return runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    const store = await readStore(dir);
    if (!store?.snapshots.some((s) => s.id === snapshotId)) {
      const err = new Error(`snapshot not found: ${snapshotId}`);
      (err as Error & { code?: string }).code = 'FILE_HISTORY_SNAPSHOT_NOT_FOUND';
      throw err;
    }
    return fs.readFile(snapshotFile(dir, snapshotId), 'utf-8');
  });
}

/** 清空某文件的全部历史（隐私入口）。删快照文件 + manifest，lastHash 归零。 */
export async function clear(fileKey: string): Promise<void> {
  await runExclusive(`history:${fileKey}`, async () => {
    const dir = dirFor(fileKey);
    await fs.rm(dir, { recursive: true, force: true });
  });
}

/**
 * 内容 hash（与快照 ref.hash 同算法）——调用方拿它在历史里按内容定位某一版。
 * 导出而非各处自算：两套 hash 域会让「按 hash 找那一版」静默找不到（同 M-1 病根）。
 */
export function contentHash(content: string): string {
  return hashOf(content);
}

/** 最新快照的内容 hash（单一真相源）。无历史返回 null。 */
export async function lastHash(fileKey: string): Promise<string | null> {
  return runExclusive(`history:${fileKey}`, async () => {
    const store = await readStore(dirFor(fileKey));
    return store?.lastHash ?? null;
  });
}

// ─── GC：到期归档里程碑 + 周期取样近密远疏稀释 + 自适应封顶 ─────
//
// 就地裁剪 snapshots 数组，返回 { removed（caller 据此删文件）, newlyArchived（本次到期归档的里程碑，
// caller 据此发系统信号） }。超保留期的版本按种类分三路（S28）：
//  - 里程碑（PROTECTED_KINDS：manual/ai/initial/pre-restore/handoff/discarded/deck 类）——**到期归档不删**
//    （G92）：打 archived 标留在时间轴上仍可找回，只发一次「已归档」系统信号；它们背着「可找回」承诺，
//    静默消失即承诺过期。只受显式保留期约束、不按封顶稀释（尽量留）。
//  - 周期取样（periodic）——**近密远疏稀释**（G40）：近期密、远期疏，超窗直接稀释掉（匿名取样锚点，
//    无「可找回」承诺，可安全稀释）。取代原朴素 FIFO。
//  - overwrite-guard——匿名高频兜底，过期即删（同笔连续覆盖的隐藏中间版，被 handoff 承接后无留存价值）。
// 不变量：①**永远保留最新一条**（lastHash 对应文件不能被删，否则真相源悬空）；②pinned 版本按龄+封顶都跳过。
// 大文件（最新快照 > 512KB）用更小的封顶激进降频压存储（§2.3）。

export function gcInPlace(
  snapshots: SnapshotRef[],
  retainAll?: boolean,
  pinned?: string[],
  now: number = Date.now(), // 可注入（测试确定性）；生产按当前时刻
): { removed: SnapshotRef[]; newlyArchived: SnapshotRef[] } {
  if (snapshots.length === 0) return { removed: [], newlyArchived: [] };
  // retainAll：全部保留、绝不自动淘汰/归档（deck 每个版本都是显式里程碑，按龄/封顶都不动）。
  // 这恰好还原旧 deck .history「commit 过的版本永不淘汰」的行为，零回退（reviewer 收敛结论）。
  if (retainAll) return { removed: [], newlyArchived: [] };
  const newest = snapshots[snapshots.length - 1];
  const cap = newest.size > LARGE_FILE_BYTES ? MAX_PER_FILE_LARGE : MAX_PER_FILE;
  const removed: SnapshotRef[] = [];
  const newlyArchived: SnapshotRef[] = [];
  // 被引用的版本免于 GC（裁定 A）：按龄段不看 PROTECTED_KINDS，故 pin 必须在按龄/封顶/稀释处都跳过。
  const isPinned = pinned && pinned.length > 0 ? (id: string) => pinned.includes(id) : () => false;

  // 1) 按龄分三路（见上）。periodic 一律留到第 2 步统一稀释（含超窗项）。
  let kept = snapshots.filter((s) => {
    if (s === newest || isPinned(s.id)) return true;
    if (now - s.createdAt <= MAX_AGE_MS) return true;
    if (PROTECTED_KINDS.has(s.kind)) {
      if (!s.archived) {
        s.archived = true; // G92：到期归档（就地打标，随 manifest 落盘），不删
        newlyArchived.push(s);
      }
      return true;
    }
    if (s.kind === 'periodic') return true; // 交给第 2 步稀释
    removed.push(s); // overwrite-guard 等匿名兜底：过期直接删
    return false;
  });

  // 2) 周期取样近密远疏稀释（G40）：桶内保最小间距，越旧间距越大；超窗（间距 Infinity）稀释掉。
  const diluted = new Set(dilutePeriodic(kept, newest, isPinned, now));
  if (diluted.size > 0) {
    for (const s of diluted) removed.push(s);
    kept = kept.filter((s) => !diluted.has(s));
  }

  // 3) 封顶：超 cap 条时从最旧端淘汰——优先淘 thinnable（periodic / overwrite-guard），
  //    里程碑（含已归档）+ pinned 尽量留；最新一条永不淘。
  //    边界（承重承诺的诚实划界）：G92「到期归档不静默删」只兜**按龄**淘汰；这里的**条数上限**
  //    是理想页 HIST 明写的另一治理维度——极端情况（单文件里程碑数 > cap 且无 thinnable 可淘）
  //    下里程碑（含已归档）仍可能被封顶淘掉。正常 cap（200/30）远大于事件数，实际几乎不触达。
  while (kept.length > cap) {
    const victimIdx = pickOldestThinnable(kept, newest, isPinned);
    if (victimIdx < 0) break; // 全是受保护/pinned 项且已到顶——不再强删（极端，正常 cap 远大于事件数）
    removed.push(kept[victimIdx]);
    kept.splice(victimIdx, 1);
  }

  if (removed.length > 0) {
    snapshots.length = 0;
    snapshots.push(...kept);
  }
  return { removed, newlyArchived };
}

/**
 * 近密远疏稀释（G40）：只吃周期取样的匿名锚点（periodic），返回该稀释掉的 ref。从最新的 periodic 往回走，
 * 保留一个就记下它的时刻；再往回，只有与上一个保留点的间距 ≥「该龄段要求的最小间距」才保留，否则稀释。
 * 龄段越老要求间距越大 → 近期密、远期疏；超保留期（间距 Infinity）一律稀释。最新一条与 pinned 不参与。
 */
function dilutePeriodic(
  list: SnapshotRef[],
  newest: SnapshotRef,
  isPinned: (id: string) => boolean,
  now: number,
): SnapshotRef[] {
  const periodics = list
    .filter((s) => s.kind === 'periodic' && s !== newest && !isPinned(s.id))
    .sort((a, b) => a.createdAt - b.createdAt);
  const victims: SnapshotRef[] = [];
  let lastKeptAt = Infinity; // 上一个保留点的时刻（从最新往回走，初值 Infinity 让最新的 periodic 必留）
  for (let i = periodics.length - 1; i >= 0; i--) {
    const s = periodics[i];
    const gap = minGapForAge(now - s.createdAt);
    if (gap !== Infinity && lastKeptAt - s.createdAt >= gap) {
      lastKeptAt = s.createdAt; // 间距够 → 保留
    } else {
      victims.push(s); // 离上一个保留点太近、或已超窗 → 稀释
    }
  }
  return victims;
}

/**
 * periodic 稀释的龄段→最小间距表（近密远疏）：<1h 全留；1–6h≥15min；6–24h≥1h；1–7d≥6h；≥7d 稀释掉。
 * 阈值为初值拍定（无实测依据，与 MAX_PER_FILE 等封顶常量同风格），方向定性正确（越旧越疏），
 * 具体分段待观察真实 .history 体积后调。
 */
function minGapForAge(age: number): number {
  if (age < HOUR_MS) return 0;
  if (age < 6 * HOUR_MS) return 15 * MINUTE_MS;
  if (age < 24 * HOUR_MS) return HOUR_MS;
  if (age < MAX_AGE_MS) return 6 * HOUR_MS;
  return Infinity;
}

/**
 * 找最旧的可淘汰项下标：先 thinnable，全无再退回最旧受保护项；最新一条 + pinned 永远跳过。
 * pinned 即便是最旧、即便全表受保护也绝不淘（被引用版本生死线-3，强于 PROTECTED_KINDS 的"尽量留"）。
 */
function pickOldestThinnable(
  snapshots: SnapshotRef[],
  newest: SnapshotRef,
  isPinned: (id: string) => boolean,
): number {
  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i] === newest || isPinned(snapshots[i].id)) continue;
    if (!PROTECTED_KINDS.has(snapshots[i].kind)) return i;
  }
  for (let i = 0; i < snapshots.length; i++) {
    if (snapshots[i] !== newest && !isPinned(snapshots[i].id)) return i;
  }
  return -1;
}
