/**
 * 项目路径沙箱校验 —— md / csv 等所有面向项目内文件的 IPC 共用（从 md.ts 原样抽出）。
 */
import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { ErrorCodes } from '@shared/types';

function escapeError(): Error & { code?: string } {
  const err = new Error('path escapes project root') as Error & { code?: string };
  err.code = ErrorCodes.FS_READ_FAILED;
  return err;
}

export async function ensureWithinProject(projectRoot: string, target: string): Promise<string> {
  const root = resolve(projectRoot);
  const abs = isAbsolute(target) ? resolve(target) : resolve(root, target);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw escapeError();
  }

  // realpath 二次校验：防项目内 symlink 父目录把写入指向项目外（与 agentTools 沙箱一致）。
  // 目标可能尚不存在（写新建），故对最近存在的祖先做 realpath，再把剩余段拼回。
  let ancestor = abs;
  while (true) {
    try {
      await fs.access(ancestor);
      break;
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        ancestor = root;
        break;
      }
      ancestor = parent;
    }
  }
  let realTarget: string | null = null;
  try {
    const realAncestor = await fs.realpath(ancestor);
    realTarget = resolve(realAncestor, relative(ancestor, abs));
  } catch {
    realTarget = null; // realpath 失败（权限等）——符号层已过，放行
  }
  if (realTarget) {
    const realRoot = await fs.realpath(root).catch(() => root);
    const rrel = relative(realRoot, realTarget);
    if (rrel.startsWith('..') || isAbsolute(rrel)) {
      throw escapeError();
    }
  }
  return abs;
}
