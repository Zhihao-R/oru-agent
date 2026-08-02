/**
 * 30 天回收站 — 被删 / 被覆盖的记忆文件原样保存
 *
 * 路径：~/.oru/users/<ownerId>/memory/trash/<YYYY-MM-DD>/<原文件名>
 * 保留期：30 天，由 dream 顺便清理
 */
import { promises as fs } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { ensureWithinRoot } from '../fs/frontmatter';
import { isProfileDocRelPath, memoryRoot, trashDir } from './paths';
import { removeIndexEntry } from './store';

function todayStr(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * 把一个记忆文件挪到回收站。
 * - 必须是 memoryRoot 下的文件（路径沙箱）
 * - 同时从 MEMORY.md 索引里删掉对应行
 * - 返回回收站绝对路径
 */
export async function moveToTrash(ownerId: string, absPath: string): Promise<string> {
  const root = memoryRoot(ownerId);
  ensureWithinRoot(root, absPath);

  const relPath = relative(root, absPath);
  const dest = join(trashDir(ownerId, todayStr()), relPath);
  await fs.mkdir(dirname(dest), { recursive: true });

  // 不存在不抛——幂等
  try {
    await fs.rename(absPath, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }

  // 从索引里删（如果有）
  await removeIndexEntry(ownerId, relPath).catch(() => {});

  return dest;
}

/**
 * 从回收站恢复（罕用，UI 待支持）。
 */
export async function restoreFromTrash(ownerId: string, trashAbsPath: string): Promise<string> {
  const trashRootForOwner = join(memoryRoot(ownerId), 'trash');
  ensureWithinRoot(trashRootForOwner, trashAbsPath);

  const rel = relative(trashRootForOwner, trashAbsPath);
  // rel 形如 "2026-04-30/agents/twin/episodes/foo.md"，去掉首段日期
  const segments = rel.split('/');
  if (segments.length < 2) throw new Error(`unexpected trash path: ${trashAbsPath}`);
  const memRel = segments.slice(1).join('/');
  const dest = join(memoryRoot(ownerId), memRel);
  await fs.mkdir(dirname(dest), { recursive: true });
  await fs.rename(trashAbsPath, dest);
  return dest;
}

/**
 * 扫描回收站里的档案文件（profile.md / self.md），返回回收站相对路径（含日期段）。
 * 除 2026-07-27 前的撤销缺陷（档案卡撤销＝删整份档案）外，没有任何路径会把档案送进
 * 回收站（applyOps / deleteEpisode 都只动 episodes）——命中即那次缺陷的遗留，boot 时
 * 据此升系统信号提示找回（PRD 2026-07-27 决策一）。
 */
export async function scanTrashedProfiles(ownerId: string): Promise<string[]> {
  const trashRoot = join(memoryRoot(ownerId), 'trash');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(trashRoot, { recursive: true, withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  return entries
    .filter((d) => d.isFile())
    .map((d) => relative(trashRoot, join(d.parentPath, d.name)))
    .filter((rel) => {
      // 去掉首段日期目录后按记忆库口径判档案（isProfileDocRelPath 排除 episodes）
      const memRel = rel.split('/').slice(1).join('/');
      return isProfileDocRelPath(memRel);
    });
}

/**
 * 清掉超过 days 天的回收站子目录。dream 顺便跑。
 */
export async function cleanupOldTrash(
  ownerId: string,
  days = 30,
  now: Date = new Date(),
): Promise<number> {
  const trashRoot = join(memoryRoot(ownerId), 'trash');
  let deleted = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(trashRoot);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw e;
  }
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - days);
  for (const name of entries) {
    // 子目录命名是 YYYY-MM-DD
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(name);
    if (!m) continue;
    const dirDate = new Date(`${name}T00:00:00.000Z`);
    if (Number.isNaN(dirDate.getTime())) continue;
    if (dirDate < cutoff) {
      await fs.rm(join(trashRoot, name), { recursive: true, force: true });
      deleted += 1;
    }
  }
  return deleted;
}

/** 测试用：拿当天的 trash 目录绝对路径 */
export function todayTrashDir(ownerId: string): string {
  return trashDir(ownerId, todayStr());
}

export { todayStr as __todayStr };
export { basename };
