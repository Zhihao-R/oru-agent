/**
 * 从外部源取代码的共用原语（plugin.install / skill.install 共用，不并存两套 fetch）。
 *
 * 只管"浅 clone 到临时目录 + 锁定 commit"——不认 plugin.json、不认 SKILL.md，校验留各调用方。
 * 失败时自清临时目录再抛。
 */
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import simpleGit from 'simple-git';

/** 浅 clone（--depth=1）githubUrl 到一个新建临时目录，返回目录 + HEAD commit。失败自清后抛。 */
export async function shallowCloneToTemp(
  githubUrl: string,
  prefix = 'oru-clone-',
): Promise<{ dir: string; commit: string }> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  try {
    const git = simpleGit({ baseDir: dir });
    await git.clone(githubUrl, '.', ['--depth=1']);
    const commit = (await git.revparse(['HEAD'])).trim();
    return { dir, commit };
  } catch (e) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 把一个浅 clone 切到锁定 commit（best-effort）。失败不抛——HEAD 内容仍可用、只是版本可能漂移。
 * shallowCloneToDir（plugin 装到正式目录）与 skills/installer（先 clone 到临时目录）共用，不各写一遍。
 */
export async function checkoutCommit(dir: string, commit: string): Promise<void> {
  if (!commit) return;
  try {
    const git = simpleGit({ baseDir: dir });
    await git.fetch(['--depth=50', 'origin', commit]);
    await git.checkout(commit);
  } catch {
    console.warn(`[oru.sourceFetch] 切到 ${commit} 失败，使用 HEAD（version 可能漂移）`);
  }
}

/**
 * 浅 clone 到正式目标目录 + 切到锁定 commit（落盘阶段用）。
 */
export async function shallowCloneToDir(
  githubUrl: string,
  destDir: string,
  commit?: string,
): Promise<void> {
  const git = simpleGit({ baseDir: join(destDir, '..') });
  const folder = destDir.split('/').pop()!;
  await git.clone(githubUrl, folder, ['--depth=1']);
  if (commit) await checkoutCommit(destDir, commit);
}
