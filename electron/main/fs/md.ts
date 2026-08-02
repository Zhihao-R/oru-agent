import { promises as fs } from 'node:fs';
import { extname, normalize } from 'node:path';
import { ErrorCodes } from '@shared/types';
import { ensureWithinProject } from './projectPath';
import { commitWorkfileWrite, type CommitResult } from './workfileWrite';

const ALLOWED_EXTENSIONS = ['.md', '.txt', '.markdown'];
// 防止 CodeMirror / 渲染卡死；超过此尺寸的 md/txt 直接拒读
const MAX_READ_BYTES = 5 * 1024 * 1024;

function ensureMarkdownExt(relPath: string): void {
  const ext = extname(relPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    const err = new Error(
      `extension not allowed: ${ext}; only ${ALLOWED_EXTENSIONS.join(', ')}`,
    ) as Error & { code?: string };
    err.code = ErrorCodes.FS_NOT_MARKDOWN;
    throw err;
  }
}

export async function readMd(projectRoot: string, relPath: string): Promise<string> {
  ensureMarkdownExt(relPath);
  const abs = await ensureWithinProject(projectRoot, normalize(relPath));
  try {
    const stat = await fs.stat(abs);
    if (stat.size > MAX_READ_BYTES) {
      const err = new Error(
        `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），超过 ${MAX_READ_BYTES / 1024 / 1024} MB 上限`,
      ) as Error & { code?: string };
      err.code = ErrorCodes.FS_READ_FAILED;
      throw err;
    }
    return await fs.readFile(abs, 'utf-8');
  } catch (e) {
    if (e instanceof Error && (e as { code?: string }).code) throw e;
    const err = new Error(`failed to read: ${relPath}`) as Error & { code?: string; cause?: unknown };
    err.code = ErrorCodes.FS_READ_FAILED;
    err.cause = e;
    throw err;
  }
}

/**
 * 写 md/txt——实时落盘走统一临界区 commitWorkfileWrite（per-workfile 锁 + overwrite-guard 兜底不丢，
 * 原子 safeWrite tmp+rename，告别此前的裸 fs.writeFile）。mark='manual' 时给当前内容打一条手动留底（⌘S）。
 * S27：带 baseline+mergeOnStale 时基线过期走锁内机械合并；返回 CommitResult 供调用方按结果打作者标/开卡。
 */
export async function writeMd(
  projectRoot: string,
  relPath: string,
  content: string,
  opts?: { mark?: 'manual'; baseline?: { content: string }; mergeOnStale?: boolean },
): Promise<CommitResult> {
  ensureMarkdownExt(relPath);
  const abs = await ensureWithinProject(projectRoot, normalize(relPath));
  try {
    return await commitWorkfileWrite({
      absPath: abs,
      content,
      by: 'user', // md 编辑器写盘=用户的笔（AI 写走 executeFileWriteProposal）
      mark: opts?.mark,
      baseline: opts?.baseline,
      mergeOnStale: opts?.mergeOnStale,
    });
  } catch (e) {
    const err = new Error(`failed to write: ${relPath}`) as Error & { code?: string; cause?: unknown };
    err.code = ErrorCodes.FS_WRITE_FAILED;
    err.cause = e;
    throw err;
  }
}
