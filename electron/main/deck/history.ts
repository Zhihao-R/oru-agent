/**
 * Deck 版本系统（不依赖 git）
 *
 * - 每个 deck 一个 `.history/manifest.json` + `.history/versions/v{N}.html`
 * - commit = 加一条 versions[] + 写新 v{N}.html + 更新 currentVersion
 * - checkout = 复制 v{N}.html 回 index.html + 改 currentVersion 指针 + 清空 undo 栈（不变量自保）
 * - isDirty = index.html 跟 currentVersion 对应的 v{N}.html 内容串相等比对
 *
 * 详 docs/tech/2026-05-26-html-deck-tech-design.md §7
 */
import { promises as fs } from 'node:fs';
import type { HistoryManifest, HistoryVersion } from '@shared/types';
import {
  deckIndexPath,
  deckLockKey,
  deckManifestPath,
  deckVersionFile,
  deckImagesDir,
} from './pathResolver';
import { resolveDeckPath, touchDeck } from './store';
import { safeWriteAsync } from '../fs/safeWrite';
import { runExclusive } from '../fs/runExclusive';
import * as fileHistory from '../fs/fileHistory';
import { diffChangedPages } from './slideUtils';
import { extractImageRefs } from './deckValidator';
import { clearAll as clearUndoStack, pushBarrier as pushUndoBarrier } from './undoStack';

/**
 * deck 落一版字节到 fileHistory 中央仓（项目B 第一期 Task4），返回 snapshot id。复用 commitSnapshot
 * （必出 ref，内容逐字节相同则复用现存快照 id——deck 版本条目仍独立，只共享字节）。
 *
 * **setRetention(retainAll) 必须在 commitSnapshot 之前**：deck 每个版本都是显式里程碑、永不自动淘汰
 * （还原旧 .history「commit 过的永不删」，零回退）。顺序反了的话首次/迁移逐版灌入时 GC 会以
 * retainAll=undefined 跑正常淘汰、把字节删掉（承重，reviewer 收敛结论）。retainAll 幂等，每次设无副作用。
 */
async function snapshotDeck(
  deckKey: string,
  kind: HistoryVersion['kind'],
  content: string,
): Promise<string> {
  await fileHistory.setRetention(deckKey, { retainAll: true });
  const ref = await fileHistory.commitSnapshot(deckKey, kind, content);
  return ref.id;
}

// ─── manifest 读写 ──────────────────────────────────────────────

async function readManifestRaw(deckPath: string): Promise<HistoryManifest | null> {
  try {
    const raw = await fs.readFile(deckManifestPath(deckPath), 'utf-8');
    const parsed = JSON.parse(raw) as HistoryManifest;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.versions)) return parsed;
  } catch {
    // 不存在
  }
  return null;
}

async function writeManifest(deckPath: string, m: HistoryManifest): Promise<void> {
  await safeWriteAsync(deckManifestPath(deckPath), JSON.stringify(m, null, 2));
}

// 迁移模块（historyMigration.ts）复用 manifest 读写——同一处实现，不另造一份
export { readManifestRaw as readManifestByPath, writeManifest as writeManifestByPath };

export async function readManifest(artifactId: string): Promise<HistoryManifest | null> {
  const deckPath = await resolveDeckPath(artifactId);
  return readManifestRaw(deckPath);
}

/**
 * 初始化新 deck 的 manifest——deck 目录刚建好后调一次。
 * 写 index.html stub + v001.html（同 stub）+ manifest currentVersion='v001' kind='initial'。
 */
export async function initManifest(artifactId: string, initialHtml: string): Promise<HistoryManifest> {
  const deckPath = await resolveDeckPath(artifactId);
  await safeWriteAsync(deckIndexPath(deckPath), initialHtml);
  // 字节进中央仓（不再写 .history/versions/vNNN.html）；deck 版本 id 仍 vNNN，snapshotId 指向字节
  const snapshotId = await snapshotDeck(deckLockKey(deckPath), 'initial', initialHtml);
  const manifest: HistoryManifest = {
    version: 1,
    artifactId,
    currentVersion: 'v001',
    versions: [
      { id: 'v001', snapshotId, createdAt: Date.now(), kind: 'initial', summary: '首次生成', changedPages: [] },
    ],
  };
  await writeManifest(deckPath, manifest);
  return manifest;
}

/**
 * 懒初始化 manifest（deck 找回 §4.1）——收编来的 deck 没有 `.history/`，第一次要落版本的
 * 那一刻才补上。有则返回；无则**从现有 index.html 快照 v001**：读 deckIndexPath，写
 * v001 = 该内容，写 manifest currentVersion='v001' kind='initial'。
 *
 * 与 initManifest 的区别：initManifest 会**覆盖 index.html**（新建空 deck 用）；ensureManifest
 * **不动 index.html**，v001 取自现有内容（收编 deck 用）。复用 writeManifest。
 */
export async function ensureManifest(artifactId: string): Promise<HistoryManifest> {
  const deckPath = await resolveDeckPath(artifactId);
  const existing = await readManifestRaw(deckPath);
  if (existing) return existing;
  const currentHtml = await fs.readFile(deckIndexPath(deckPath), 'utf-8');
  const snapshotId = await snapshotDeck(deckLockKey(deckPath), 'initial', currentHtml);
  const manifest: HistoryManifest = {
    version: 1,
    artifactId,
    currentVersion: 'v001',
    versions: [
      { id: 'v001', snapshotId, createdAt: Date.now(), kind: 'initial', summary: '收编首版', changedPages: [] },
    ],
  };
  await writeManifest(deckPath, manifest);
  return manifest;
}

// ─── commit / list / checkout ───────────────────────────────────

/**
 * 落一个新版本（**锁壳**）：进 per-deck 的 `runExclusive(indexPath)` 同一把锁——与 applyTextEdit /
 * reorderSlides 共用，串行化所有 index.html 写 + 版本 commit，消除并发 commit 抢 manifest 丢版本
 * （技术设计 §2.5a/c）。indexPath 字面与 applyInlineEdit 一致（都是 deckIndexPath(resolveDeckPath(id))）。
 *
 * 已持有该锁的 caller（如 reorderSlides 整段入锁）必须直接调无锁内核 commitVersionLocked，
 * 不得再走本锁壳——否则锁内等自己＝自死锁（技术设计 §2.5c / CLAUDE.md「Promise queue 自死锁」）。
 */
export async function commitVersion(
  artifactId: string,
  kind: HistoryVersion['kind'],
  summary: string,
): Promise<HistoryVersion> {
  const deckPath = await resolveDeckPath(artifactId);
  return runExclusive(deckLockKey(deckPath), () => commitVersionLocked(artifactId, kind, summary));
}

/**
 * 落一个新版本（**无锁内核**）：读当前 index.html、跟 currentVersion v{N}.html 比对算 changedPages、
 * 写 v{N+1}.html、更新 manifest。供「已持 indexPath 锁」的 caller 直接调（reorderSlides / commitScheduler 持锁路径）。
 *
 * caller 提供 kind 和 summary——summary 派生逻辑（PRD §4 第 155 行）在 caller 一侧拼好再传，
 * 本函数只负责落盘 + 算 changedPages。
 */
export async function commitVersionLocked(
  artifactId: string,
  kind: HistoryVersion['kind'],
  summary: string,
): Promise<HistoryVersion> {
  const deckPath = await resolveDeckPath(artifactId);
  const deckKey = deckLockKey(deckPath);
  // 收编 deck 首次落版本时无 manifest → 懒初始化 v001（从现有 index.html 快照），再继续
  const manifest = await ensureManifest(artifactId);
  const currentHtml = await fs.readFile(deckIndexPath(deckPath), 'utf-8');
  // 前一版内容按版本 snapshotId 路由取（中央仓 or legacy），仍走 diffChangedPages 算「改了第几页」标签
  const prevHtml = await readVersionBytes(deckPath, manifest, manifest.currentVersion);
  const changedPages = diffChangedPages(prevHtml, currentHtml);
  const id = nextVersionId(manifest);
  // deck 始终为本次 commit 新建一条版本条目（保 summary/kind/零回退）。字节路由按当前 deck 模式：
  // 中央仓（已迁移/新建）→ snapshotDeck（去重 + retainAll 永不淘汰）；legacy（未迁移/回滚）→ 写 vNNN.html。
  let snapshotId: string | undefined;
  if (usesCentralStore(manifest)) {
    snapshotId = await snapshotDeck(deckKey, kind, currentHtml);
  } else {
    await safeWriteAsync(deckVersionFile(deckPath, id), currentHtml); // legacy 字节
  }
  const version: HistoryVersion = { id, snapshotId, createdAt: Date.now(), kind, summary, changedPages };
  manifest.versions.push(version);
  manifest.currentVersion = id;
  await writeManifest(deckPath, manifest);
  await touchDeck(artifactId);
  // 落版本时 push undo barrier——Ctrl+Z 不跨版本边界（PRD §4 第 139 行 / tech doc §10）
  pushUndoBarrier(artifactId);
  return version;
}

export async function listVersions(artifactId: string): Promise<HistoryVersion[]> {
  const manifest = await readManifest(artifactId);
  return manifest?.versions ?? [];
}

/**
 * Checkout 一个旧版本作为新起点。
 * - 不新增版本（只改 currentVersion 指针）；caller 若在 checkout 前发现 isDirty，应先 commitVersion('protective', ...)
 * - missingImages 检查——missing 非空 + !force 时返回 ok=false 让前端弹询问
 * - 成功后**内部**调 undoStack.clearAll(artifactId)——把"checkout 后 undo 不一致"的不变量保证收在 history 里，
 *   避免每个 caller 都得记得调一次清栈
 */
/**
 * 取某 deck 版本的完整字节内容（公共 seam）——对比/历史缩略图/任何"看某旧版"都走它。
 * 据 manifest 把 deck 版本 id（vNNN）解析到 snapshotId，从中央仓 restore。Task6 的迁移路由
 * （未迁移 deck 读旧 vNNN.html）也叠在这一处，调用方无需关心字节落点。
 */
export async function restoreVersionContent(artifactId: string, versionId: string): Promise<string> {
  const deckPath = await resolveDeckPath(artifactId);
  const manifest = await readManifestRaw(deckPath);
  if (!manifest) {
    const err = new Error(`no manifest for deck: ${artifactId}`) as Error & { code?: string };
    err.code = 'DECK_HISTORY_VERSION_NOT_FOUND';
    throw err;
  }
  return readVersionBytes(deckPath, manifest, versionId);
}

export type CheckoutResult =
  | { ok: true }
  | { ok: false; missingImages: string[] };

export async function checkoutVersion(
  artifactId: string,
  versionId: string,
  opts: { force?: boolean } = {},
): Promise<CheckoutResult> {
  const deckPath = await resolveDeckPath(artifactId);
  // checkout 写 index.html，纳入同一把 deckLockKey 锁（与 commitVersion/reorderSlides/applyTextEdit 同步序），
  // 不与并发的行内编辑/重排交错丢写
  return runExclusive(deckLockKey(deckPath), async () => {
    // 与 commitVersion 对称的懒初始化（基本是空保险——收编 deck 没 commit 过、无 versionId 可
    // checkout；ensureManifest 建出 v001 后 versions.find 仍 not-found 正常报错）
    const manifest = await ensureManifest(artifactId);
    const target = manifest.versions.find((v) => v.id === versionId);
    if (!target) {
      const err = new Error(`version not found: ${versionId}`);
      (err as Error & { code?: string }).code = 'DECK_HISTORY_VERSION_NOT_FOUND';
      throw err;
    }
    const targetHtml = await readVersionBytes(deckPath, manifest, versionId);
    if (!opts.force) {
      const missing = await scanMissingImages(targetHtml, deckPath);
      if (missing.length > 0) return { ok: false, missingImages: missing };
    }
    await safeWriteAsync(deckIndexPath(deckPath), targetHtml);
    manifest.currentVersion = versionId;
    await writeManifest(deckPath, manifest);
    await touchDeck(artifactId);
    // checkout 跨版本 → undo 栈相对旧 HTML 的 delta 不再有效，必须清空（详 tech doc §7.6）
    clearUndoStack(artifactId);
    return { ok: true };
  });
}

/** 当前 index.html 跟 currentVersion 对应的 v{N}.html 内容不一样 = dirty */
export async function isDirty(artifactId: string): Promise<boolean> {
  const deckPath = await resolveDeckPath(artifactId);
  const manifest = await readManifestRaw(deckPath);
  if (!manifest) return false;
  try {
    const indexHtml = await fs.readFile(deckIndexPath(deckPath), 'utf-8');
    const verHtml = await readVersionBytes(deckPath, manifest, manifest.currentVersion);
    return indexHtml !== verHtml;
  } catch {
    return false;
  }
}

// ─── 内部 helper ────────────────────────────────────────────────

/**
 * 取某 deck 版本的字节——字节路由的**单一信号是该版本的 snapshotId 是否存在**（项目B 第一期）：
 * 有 → fileHistory 中央仓（已迁移/新建 deck）；无 → legacy `.history/versions/vNNN.html`
 * （未迁移老 deck / 已回滚 deck）。读路径无需额外 mode 标志，迁移即「给所有版本补 snapshotId」的翻转。
 */
async function readVersionBytes(
  deckPath: string,
  manifest: HistoryManifest,
  versionId: string,
): Promise<string> {
  const v = manifest.versions.find((x) => x.id === versionId);
  if (!v) {
    const err = new Error(`version not found: ${versionId}`) as Error & { code?: string };
    err.code = 'DECK_HISTORY_VERSION_NOT_FOUND';
    throw err;
  }
  if (v.snapshotId) return fileHistory.restore(deckLockKey(deckPath), v.snapshotId);
  return fs.readFile(deckVersionFile(deckPath, versionId), 'utf-8'); // legacy 字节
}

/** 该 deck 当前是否走中央仓字节路径（currentVersion 带 snapshotId）。空 manifest 视为新路径。 */
function usesCentralStore(manifest: HistoryManifest): boolean {
  if (manifest.versions.length === 0) return true;
  return !!manifest.versions.find((v) => v.id === manifest.currentVersion)?.snapshotId;
}

function nextVersionId(manifest: HistoryManifest): string {
  // 找出 versions 里数字最大的 vNNN，递增；不直接用 versions.length 因为未来可能允许删除版本
  const max = manifest.versions
    .map((v) => parseInt(v.id.replace(/^v/, ''), 10))
    .filter((n) => Number.isFinite(n))
    .reduce((a, b) => Math.max(a, b), 0);
  return `v${String(max + 1).padStart(3, '0')}`;
}

/**
 * 扫 HTML 里 `src="images/..."` 这种相对路径引用——返回不存在的文件名列表。
 * 抽引用复用 deckValidator.extractImageRefs（不并存两份正则，系统性；它顺带去 querystring）。
 */
async function scanMissingImages(html: string, deckPath: string): Promise<string[]> {
  const missing: string[] = [];
  const imagesRoot = deckImagesDir(deckPath);
  for (const ref of extractImageRefs(html)) {
    const rel = ref.replace(/^images\//, '');
    try {
      await fs.access(`${imagesRoot}/${rel}`);
    } catch {
      missing.push(ref);
    }
  }
  return missing;
}
