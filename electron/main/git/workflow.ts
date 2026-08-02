import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { GitFileStatus, GitStatus } from '@shared/types';
import { ErrorCodes } from '@shared/types';
import { slugify } from '@shared/ids';

const PROTECTED_BRANCHES = new Set(['main', 'master', 'test1', 'test2', 'prod']);

function fail(code: string, message: string): never {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  throw err;
}

function git(projectPath: string): SimpleGit {
  if (!existsSync(join(projectPath, '.git'))) {
    fail(ErrorCodes.GIT_NO_REPO, `not a git repository: ${projectPath}`);
  }
  return simpleGit({ baseDir: projectPath });
}

export function isProtectedBranch(branch: string): boolean {
  return PROTECTED_BRANCHES.has(branch);
}

export function mapShortStatus(code: string): GitFileStatus {
  // simple-git working_dir/index 是单字符
  if (code === '?') return 'untracked';
  if (code === 'M') return 'modified';
  if (code === 'A') return 'added';
  if (code === 'D') return 'deleted';
  if (code === 'R') return 'renamed';
  if (code === 'U') return 'conflicted';
  return 'modified';
}

export async function getStatus(projectPath: string): Promise<GitStatus> {
  const g = git(projectPath);
  try {
    const s = await g.status();
    const files = s.files.map((f) => {
      // 优先看 working_dir，否则 index
      const code = (f.working_dir && f.working_dir !== ' ' ? f.working_dir : f.index) || '?';
      return { path: f.path, status: mapShortStatus(code) };
    });
    return {
      branch: s.current ?? 'HEAD',
      upstream: s.tracking ?? null,
      ahead: s.ahead ?? 0,
      behind: s.behind ?? 0,
      files,
      isClean: s.files.length === 0,
    };
  } catch (e) {
    fail(ErrorCodes.GIT_FAILED, e instanceof Error ? e.message : String(e));
  }
}

export async function getDiff(projectPath: string): Promise<string> {
  const g = git(projectPath);
  try {
    // 包含未暂存 + 已暂存
    const unstaged = await g.diff();
    const staged = await g.diff(['--cached']);
    return [staged, unstaged].filter(Boolean).join('\n');
  } catch (e) {
    fail(ErrorCodes.GIT_FAILED, e instanceof Error ? e.message : String(e));
  }
}

/**
 * 确保切到一条非保护的 oru/<slug> 分支；返回最终所在分支
 * 如果当前已经在非保护分支上，直接返回当前分支
 */
export async function ensureFeatureBranch(projectPath: string, slugSeed: string): Promise<string> {
  const g = git(projectPath);
  const current = (await g.branch()).current;
  if (current && !isProtectedBranch(current)) return current;

  const branch = `oru/${slugify(slugSeed) || 'task'}`;
  // 如果分支已存在，直接切；否则新建
  const branches = await g.branch(['--list', branch]);
  if (branches.all.includes(branch)) {
    await g.checkout(branch);
  } else {
    await g.checkoutLocalBranch(branch);
  }
  return branch;
}

export async function commitWithMessage(projectPath: string, message: string): Promise<string> {
  const g = git(projectPath);
  const branch = (await g.branch()).current;
  if (isProtectedBranch(branch)) {
    fail(ErrorCodes.GIT_PROTECTED_BRANCH, `refuse to commit on protected branch: ${branch}`);
  }
  try {
    await g.add(['-A']);
    const result = await g.commit(message);
    return result.commit;
  } catch (e) {
    fail(ErrorCodes.GIT_FAILED, e instanceof Error ? e.message : String(e));
  }
}

export async function pushCurrentBranch(projectPath: string): Promise<{ branch: string; pushed: boolean; reason?: string }> {
  const g = git(projectPath);
  const branch = (await g.branch()).current;
  if (isProtectedBranch(branch)) {
    fail(ErrorCodes.GIT_PROTECTED_BRANCH, `refuse to push protected branch: ${branch}`);
  }
  let remotes: string[] = [];
  try {
    const list = await g.getRemotes(false);
    remotes = list.map((r) => r.name);
  } catch {
    remotes = [];
  }
  if (remotes.length === 0) {
    return { branch, pushed: false, reason: 'no remote configured' };
  }
  try {
    await g.push(['-u', remotes[0], branch]);
    return { branch, pushed: true };
  } catch (e) {
    fail(ErrorCodes.GIT_FAILED, e instanceof Error ? e.message : String(e));
  }
}

