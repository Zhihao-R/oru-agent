/**
 * createFile / createDir —— "建一个新东西"的创建链路，与各编辑器的"保存"链路（writeMd /
 * writeTextFile）分开：保存绑死单一格式，创建是跨格式（.md/.csv）且必须无覆盖。
 *
 * 无覆盖靠 OS 级原子排他建（writeFile 的 'wx' 标志 / 非 recursive mkdir），而非
 * "先查存在再写"——后者在并发同名时两路都判"不存在"会双双落盘。tmp+rename 的 safeWrite
 * 是覆盖语义，做不到排他，故这里不复用它（技术方案修订记录）。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, extname, normalize } from 'node:path';
import { ErrorCodes } from '@shared/types';
import { ensureWithinProject } from './projectPath';
import { recordOruWrite } from './oruWrites';

export type CreateResult = { status: 'ok' } | { status: 'conflict' } | { status: 'invalid' };

const ALLOWED_EXTENSIONS = ['.md', '.csv'];

function codedError(message: string, cause: unknown): Error {
  const err = new Error(message) as Error & { code?: string; cause?: unknown };
  err.code = ErrorCodes.FS_WRITE_FAILED;
  err.cause = cause;
  return err;
}

/**
 * 无覆盖原子建文件。扩展名限 .md / .csv（其余 invalid）；目标已存在 → conflict 且字节不动。
 * 'wx' = O_CREAT|O_EXCL，open 在 OS 层原子，并发两次同名只有一个成功、另一个得 EEXIST。
 */
export async function createFile(
  projectRoot: string,
  relPath: string,
  content: string,
): Promise<CreateResult> {
  if (!ALLOWED_EXTENSIONS.includes(extname(relPath).toLowerCase())) return { status: 'invalid' };
  const abs = await ensureWithinProject(projectRoot, normalize(relPath));
  await mkdir(dirname(abs), { recursive: true }); // 父目录是手段，按需补齐
  try {
    await writeFile(abs, content, { encoding: 'utf-8', flag: 'wx' });
    recordOruWrite(abs); // bash 执行后校验据此排除 Oru 自有写盘（与 safeWrite 一致）
    return { status: 'ok' };
  } catch (e) {
    if ((e as { code?: string }).code === 'EEXIST') return { status: 'conflict' };
    throw codedError(`failed to create: ${relPath}`, e);
  }
}

/**
 * 建空目录（非 recursive）。目标已存在（目录或同名文件）→ conflict——
 * 目标目录是目的本身，撞名必须如实报，不被 recursive 静默吞；父目录才按需补齐。
 */
export async function createDir(projectRoot: string, relPath: string): Promise<CreateResult> {
  const abs = await ensureWithinProject(projectRoot, normalize(relPath));
  await mkdir(dirname(abs), { recursive: true }); // 父目录按需补齐
  try {
    await mkdir(abs); // 非 recursive：已存在抛 EEXIST
    return { status: 'ok' };
  } catch (e) {
    if ((e as { code?: string }).code === 'EEXIST') return { status: 'conflict' };
    throw codedError(`failed to mkdir: ${relPath}`, e);
  }
}
