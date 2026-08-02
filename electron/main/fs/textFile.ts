/**
 * textFile —— 表格（.csv）保存链路的读写内核。
 *
 * 不复用 writeMd 的三个理由（tech design「草稿与保存」）：md 链路有 .md/.txt/.markdown
 * 硬白名单、5MB 读上限不够装表、writeMd 是裸 fs.writeFile 不走原子写。
 *
 * 写入带 expectedDiskSha256 前置校验：哈希在 main 侧紧贴写盘比对，消灭"渲染进程比对
 * 通过 → 写盘落地"之间的 TOCTOU 窗口；conflict 是正常业务结果（结构化返回），不是异常。
 */
import { createHash } from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import { extname, normalize } from 'node:path';
import { ErrorCodes } from '@shared/types';
import { decodeCsvBytes, isEncodingSafe } from '@shared/csv';
import { safeWriteAsync } from './safeWrite';
import { ensureWithinProject } from './projectPath';
import { commitWorkfileWrite } from './workfileWrite';

// 读上限按表格上限（10 万行）放宽——宽行（20 列 × 长文本）也装得下；超限文件走 streaming 预览，不经这里
const MAX_READ_BYTES = 256 * 1024 * 1024;

export type TextReadResult = {
  content: string;
  /**
   * 只看编码（无 BOM 的合法 UTF-8）。「要不要弹确认」的**唯一**判据，保存、导出、AI 出口闸门共用：
   * 编码转换重写全文件字节、毁了原件回不来，值得用户拍板；风格差异（多余引号 / CRLF / 缺尾换行）
   * 重写无损、用户没有可判之处，拦它只是问一句他答不上来的话（论证见 @shared/csv 的 isEncodingSafe）。
   */
  encodingSafe: boolean;
  encoding: 'utf-8' | 'gbk';
  mtimeMs: number;
  /** 磁盘原始字节的 sha256（hex）——保存时作 expectedDiskSha256 的基线 */
  sha256: string;
};

export type TextWriteResult =
  | { status: 'saved'; mtimeMs: number; sha256: string }
  | { status: 'conflict' };

function codedError(message: string, code: string): Error {
  const err = new Error(message) as Error & { code?: string };
  err.code = code;
  return err;
}

function ensureCsvExt(relPath: string): void {
  if (extname(relPath).toLowerCase() !== '.csv') {
    throw codedError(`extension not allowed: 只支持 .csv（收到 ${relPath}）`, ErrorCodes.FS_WRITE_FAILED);
  }
}

const sha256Hex = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

/** 磁盘文件流式 sha256；不存在或读取中途失败（access 后被删）都返回 null——
 *  调用方按"期望哈希对不上"走 conflict，而不是把结构化结果炸成异常。 */
async function hashDisk(abs: string): Promise<string | null> {
  try {
    await fs.access(abs);
    return await new Promise<string>((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = createReadStream(abs);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  } catch {
    return null;
  }
}

export async function readTextFile(
  projectRoot: string,
  relPath: string,
  maxBytes: number = MAX_READ_BYTES,
): Promise<TextReadResult> {
  ensureCsvExt(relPath);
  const abs = await ensureWithinProject(projectRoot, normalize(relPath));
  const stat = await fs.stat(abs).catch(() => {
    throw codedError(`文件不存在或不可读：${relPath}`, ErrorCodes.FS_READ_FAILED);
  });
  if (stat.size > maxBytes) {
    throw codedError(
      `文件过大（${(stat.size / 1024 / 1024).toFixed(1)} MB），超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`,
      ErrorCodes.FS_READ_FAILED,
    );
  }
  const buf = await fs.readFile(abs);
  const bytes = new Uint8Array(buf);
  const decoded = decodeCsvBytes(bytes); // 无法识别编码时抛错，消息原样给前端
  return {
    content: decoded.text,
    encodingSafe: isEncodingSafe(bytes),
    encoding: decoded.encoding,
    mtimeMs: Math.floor(stat.mtimeMs),
    sha256: sha256Hex(buf),
  };
}

/**
 * 写入 .csv。
 *  - expectedDiskSha256 缺省（undefined）：实时落盘，走统一临界区 commitWorkfileWrite
 *    （per-workfile 锁 + overwrite-guard 兜底不丢）；mark='manual' 给当前内容打一条手动留底。
 *  - expectedDiskSha256 = null / hex：期望文件不存在 / 字节哈希一致（另存规范副本的「不撞名」校验用），
 *    不一致返回 conflict、文件不被触碰；这条路是「建新文件」语义，不进 overwrite-guard。
 */
export async function writeTextFile(
  projectRoot: string,
  relPath: string,
  content: string,
  expectedDiskSha256?: string | null,
  mark?: 'manual',
): Promise<TextWriteResult> {
  ensureCsvExt(relPath);
  const abs = await ensureWithinProject(projectRoot, normalize(relPath));
  if (expectedDiskSha256 !== undefined) {
    const current = await hashDisk(abs);
    if (current !== expectedDiskSha256) return { status: 'conflict' };
    await safeWriteAsync(abs, content, 'LF'); // 建新文件路径（另存副本），无前版可兜
  } else {
    await commitWorkfileWrite({ absPath: abs, content, by: 'user', mark }); // 实时落盘：覆盖前兜底不丢（用户的笔）
  }
  const stat = await fs.stat(abs);
  return {
    status: 'saved',
    mtimeMs: Math.floor(stat.mtimeMs),
    sha256: sha256Hex(Buffer.from(content, 'utf-8')),
  };
}

/** 磁盘现状摘要——外部变更检测用（watcher 报变后前端来问一次）。 */
export async function hashTextFile(
  projectRoot: string,
  relPath: string,
): Promise<{ sha256: string | null; size: number; mtimeMs: number }> {
  ensureCsvExt(relPath);
  const abs = await ensureWithinProject(projectRoot, normalize(relPath));
  try {
    const stat = await fs.stat(abs);
    const sha = await hashDisk(abs);
    return { sha256: sha, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) };
  } catch {
    return { sha256: null, size: 0, mtimeMs: 0 };
  }
}
