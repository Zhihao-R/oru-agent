/**
 * Deck 注册表 + active deck 进程内状态
 *
 * 注册表落盘在 `~/.oru/users/<ownerId>/artifacts.json`（v1 旧文件名 decks.json 自动迁移）。
 * active artifactId 在主进程内存里（重启清零，跟 activeProjectId 一致；阶段 4 接通预览面板后视用户体感再决定是否持久化）。
 *
 * 不依赖 git；deck 内容本身在 project.path/<deckName>/，本模块只负责"哪些 deck 存在 / 当前激活哪个"。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { ArtifactRecord } from '@shared/types';
import { newDeckId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { userDir } from '../runtime/paths';
import { safeWriteAsync } from '../fs/safeWrite';
import { sanitizeDeckName, pickUniqueName } from './pathResolver';

function artifactsPath(ownerId: string): string {
  return join(userDir(ownerId), 'artifacts.json');
}

function legacyDecksPath(ownerId: string): string {
  return join(userDir(ownerId), 'decks.json');
}

type DecksFile = { version: 1; decks: ArtifactRecord[] };

/**
 * 一次性迁移：若 artifacts.json 不存在但旧 decks.json 存在，
 * 将旧文件内容原样写到 artifacts.json（decks.json 退役为只读 legacy，不再写）。
 * 以 artifacts.json 是否存在作为"已迁移"标志，幂等。
 */
async function migrateRegistryIfNeeded(ownerId: string): Promise<void> {
  const newPath = artifactsPath(ownerId);
  const oldPath = legacyDecksPath(ownerId);

  // artifacts.json 已存在 → 已迁移，跳过
  try {
    await fs.access(newPath);
    return;
  } catch { /* 不存在，继续检查旧文件 */ }

  // 尝试读旧 decks.json
  try {
    const raw = await fs.readFile(oldPath, 'utf-8');
    const parsed = JSON.parse(raw) as DecksFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.decks)) {
      await safeWriteAsync(newPath, JSON.stringify(parsed, null, 2));
    }
  } catch { /* 旧文件不存在或损坏 → 不迁移，后续直接建空新文件 */ }
}

async function readDecksFile(): Promise<DecksFile> {
  const ownerId = getCurrentOwnerId();
  await migrateRegistryIfNeeded(ownerId);
  const path = artifactsPath(ownerId);
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as DecksFile;
    if (parsed && parsed.version === 1 && Array.isArray(parsed.decks)) return parsed;
  } catch {
    // 不存在或损坏 → 空索引
  }
  return { version: 1, decks: [] };
}

async function writeDecksFile(f: DecksFile): Promise<void> {
  const path = artifactsPath(getCurrentOwnerId());
  await safeWriteAsync(path, JSON.stringify(f, null, 2));
}

/**
 * 写锁——同进程内串行所有 mutateDecks 调用，避免 createDeck 并发 RMW 竞争。
 * 详 CLAUDE.md memory `feedback_atomic_rmw_must_be_in_lock`。
 *
 * 实现：Promise 链——新调用排队等上一个 Promise resolve；不会重入死锁因为锁内不再调 mutateDecks。
 */
let writeChain: Promise<unknown> = Promise.resolve();

async function mutateDecks<T>(fn: (f: DecksFile) => Promise<T> | T): Promise<T> {
  const next = writeChain.then(async () => {
    const f = await readDecksFile();
    const r = await fn(f);
    await writeDecksFile(f);
    return r;
  });
  // chain 错误不能拖垮下个调用——swallow rejection in chain，但 caller 仍能拿到原 error
  writeChain = next.catch(() => undefined);
  return next;
}

/** 列出某项目下的所有 deck，按 updatedAt 倒序 */
export async function listDecks(projectId: string): Promise<ArtifactRecord[]> {
  const f = await readDecksFile();
  return f.decks
    .filter((d) => d.projectId === projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 按 artifactId 取记录；不存在返回 null */
export async function getDeck(artifactId: string): Promise<ArtifactRecord | null> {
  const f = await readDecksFile();
  return f.decks.find((d) => d.id === artifactId) ?? null;
}

/**
 * 创建一个新 deck 目录 + 注册表记录。
 * - 在 projectPath 下挑唯一目录名（sanitize + 重名后缀）
 * - 不写 index.html / manifest——交给 history.ts 的 initManifest 和 caller 写空 stub
 * - RMW 整体在锁内：并发同名 createDeck 不会建出两条孤儿
 */
export async function createDeck(args: {
  projectId: string;
  projectPath: string;
  name: string;
  /** 选用的 deck skill id——持久化进记录，事后生成（generate_deck）复用 */
  deckSkillId?: string;
}): Promise<ArtifactRecord> {
  if (!sanitizeDeckName(args.name)) {
    const err = new Error('deck name 非法或为空') as Error & { code?: string };
    err.code = 'DECK_NAME_INVALID';
    throw err;
  }
  return mutateDecks(async (f) => {
    const dirName = await pickUniqueName(args.projectPath, args.name);
    const deckPath = join(args.projectPath, dirName);
    await fs.mkdir(deckPath, { recursive: true });
    await fs.mkdir(join(deckPath, 'images'), { recursive: true });
    const now = Date.now();
    const record: ArtifactRecord = {
      id: newDeckId(),
      projectId: args.projectId,
      name: args.name,
      path: deckPath,
      createdAt: now,
      updatedAt: now,
      deckSkillId: args.deckSkillId,
    };
    f.decks.push(record);
    return record;
  });
}

/**
 * 收编一个**已存在**的文件夹为 deck（「加入演示稿」，deck 找回 §3.1）。
 * 与 createDeck 的分工：createDeck = 新建空 deck（mkdir + images/）；本函数 = 纯登记一个指针，
 * **不 mkdir、不写 stub、不 initManifest**（PRD 决策三：加入只记一条登记，不动原件）。
 * 幂等：同 path 已登记 → 直接返回原记录，不重复加入。共用 mutateDecks 写锁。
 */
export async function registerExistingDeck(args: {
  projectId: string;
  name: string;
  path: string;
}): Promise<ArtifactRecord> {
  return mutateDecks(async (f) => {
    const existing = f.decks.find((d) => d.path === args.path);
    if (existing) return existing;
    const now = Date.now();
    const record: ArtifactRecord = {
      id: newDeckId(),
      projectId: args.projectId,
      name: args.name,
      path: args.path,
      createdAt: now,
      updatedAt: now,
    };
    f.decks.push(record);
    return record;
  });
}

/** 删 deck 注册表记录（不删磁盘目录——用户文件由用户管）。performDeckCreate 出错时回滚也用此 */
export async function unregisterDeck(artifactId: string): Promise<void> {
  await mutateDecks((f) => {
    f.decks = f.decks.filter((d) => d.id !== artifactId);
  });
}

/** 更新 updatedAt（落版本 / 加注释等时调） */
export async function touchDeck(artifactId: string): Promise<void> {
  await mutateDecks((f) => {
    const d = f.decks.find((x) => x.id === artifactId);
    if (d) d.updatedAt = Date.now();
  });
}

// ─── active artifactId（进程内单例，仿 activeProject）────────────────
let activeDeckId: string | null = null;

export function getActiveDeckId(): string | null {
  return activeDeckId;
}

export function setActiveDeckId(id: string | null): void {
  activeDeckId = id;
}

/** 解析 artifactId → 绝对路径；找不到抛 DECK_NOT_FOUND */
export async function resolveDeckPath(artifactId: string): Promise<string> {
  const d = await getDeck(artifactId);
  if (!d) {
    const err = new Error(`deck not found: ${artifactId}`) as Error & { code?: string };
    err.code = 'DECK_NOT_FOUND';
    throw err;
  }
  return d.path;
}
