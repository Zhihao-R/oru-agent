/**
 * safeWrite —— 原子落盘内核（移植 claude code `src/utils/file.ts`，砍掉环境耦合）。
 *
 * 移植保留：
 *   - 原子写：写 `tmp.<pid>.<seq>` → flush → chmod 保权限 → rename
 *   - 自动 mkdir -p
 *   - 换行符保真：读时探测 CRLF/UTF-16 归一为 LF，写回还原——收益对象是审批卡 diff 预览，
 *     避免 CRLF↔LF 翻转致整篇 diff 爆炸
 *
 * 砍掉（claude code 环境耦合）：LSP 通知、团队密钥检查、UNC 分支、文件历史备份、
 *   skill 发现、readFileState、analytics、symlink 写穿（写穿越界由 pathSandbox 兜）。
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { recordOruWrite } from './oruWrites';

export type LineEnding = 'LF' | 'CRLF';

// 进程内自增计数器——替代 claude code 的 Date.now() 后缀，避免同毫秒两次写入 tmp 名冲突。
let tmpSeq = 0;

/**
 * 写盘失败上报钩子（S14 · G106「写盘失败」系统信号）——依赖注入，避免 fs/ 反向依赖 notifications/。
 * 主进程装配时注入 feedWriteFailure；未注入（测试 / 早于装配）时静默。只在失败分支调，不碰热路径。
 */
type WriteFailureReporter = (absPath: string, err: unknown) => void;
let writeFailureReporter: WriteFailureReporter | null = null;
export function setWriteFailureReporter(fn: WriteFailureReporter | null): void {
  writeFailureReporter = fn;
}

/**
 * 原子落盘：先写临时文件再 rename（POSIX 下 rename 原子）。
 * 覆盖既有文件时保留其权限位；任一步失败清理 tmp 后抛出。
 */
export function safeWrite(absPath: string, content: string, lineEnding: LineEnding): void {
  const toWrite = applyLineEnding(content, lineEnding);

  mkdirSync(dirname(absPath), { recursive: true });

  // 覆盖既有文件时记下原 mode，落盘后 chmod 回去
  let targetMode: number | undefined;
  try {
    targetMode = statSync(absPath).mode;
  } catch {
    // 目标不存在——新建，无需保权限
  }

  const tmp = `${absPath}.tmp.${process.pid}.${tmpSeq++}`;
  try {
    writeFileSync(tmp, toWrite, { encoding: 'utf-8', flush: true });
    if (targetMode !== undefined) chmodSync(tmp, targetMode);
    renameSync(tmp, absPath);
    recordOruWrite(absPath); // bash 执行后校验据此排除 Oru 自有写盘
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // tmp 可能没建成——忽略清理失败
    }
    writeFailureReporter?.(absPath, e); // 升系统信号（产出无处落盘）后照旧抛给调用方
    throw e;
  }
}

/**
 * safeWrite 的异步版——同一套 tmp+rename 语义，给主进程里大文件 / 高频写场景用
 * （deck 的 HTML 可达数百 KB，同步写会阻塞主进程 event loop）。
 * 生成型写入（deck HTML / JSON store）不跟踪源文件换行风格，lineEnding 默认 LF。
 * runtime/atomicStore 的 writeAtomic 同样代理到这里——全仓库原子写只有这一套内核。
 */
export async function safeWriteAsync(
  absPath: string,
  content: string,
  lineEnding: LineEnding = 'LF',
): Promise<void> {
  const toWrite = applyLineEnding(content, lineEnding);

  await mkdir(dirname(absPath), { recursive: true });

  let targetMode: number | undefined;
  try {
    targetMode = (await stat(absPath)).mode;
  } catch {
    // 目标不存在——新建，无需保权限
  }

  const tmp = `${absPath}.tmp.${process.pid}.${tmpSeq++}`;
  try {
    await writeFile(tmp, toWrite, { encoding: 'utf-8', flush: true });
    if (targetMode !== undefined) await chmod(tmp, targetMode);
    await rename(tmp, absPath);
    recordOruWrite(absPath); // 同步版注释同
  } catch (e) {
    await unlink(tmp).catch(() => {
      // tmp 可能没建成——忽略清理失败
    });
    writeFailureReporter?.(absPath, e); // 升系统信号（产出无处落盘）后照旧抛给调用方
    throw e;
  }
}

/**
 * 解码后字符串的「读时归一」单一出处：剥残留 BOM 字符（U+FEFF）+ CRLF→LF。
 * readWithMeta(Async) 与 applyTextEdit 的覆盖前快照共用——保证落进 FileHistory 的内容 hash 口径
 * 一致（lastHash 单一真相源不分裂、跨路径去重不重存）。UTF-16 字节序解码是 buffer 级、各读函数自理，
 * 不在本字符串级归一内（applyTextEdit 是 utf-8 路径，本就不解 UTF-16）。
 */
export function normalizeDecoded(content: string): string {
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return stripped.replaceAll('\r\n', '\n');
}

/**
 * 读文件并返回内容（归一为 LF）+ 探测到的换行风格 + floor 后的 mtime。
 * BOM 探 UTF-16（LE/BE），否则按 UTF-8。
 */
export function readWithMeta(absPath: string): { content: string; lineEnding: LineEnding; mtimeMs: number } {
  const buf = readFileSync(absPath);
  const mtimeMs = Math.floor(statSync(absPath).mtimeMs);

  let content: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    content = buf.toString('utf16le'); // UTF-16 LE BOM
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // UTF-16 BE：Node 无原生 utf16be 编码，swap16 后按 LE 解
    const swapped = Buffer.from(buf);
    swapped.swap16();
    content = swapped.toString('utf16le');
  } else {
    content = buf.toString('utf-8');
  }

  // detect 在归一前（需看到 CRLF）；BOM 不含 '\n'，不影响行尾计数
  const lineEnding = detectLineEndings(content.slice(0, 4096));
  return { content: normalizeDecoded(content), lineEnding, mtimeMs };
}

/** readWithMeta 的异步版——同一套 BOM/CRLF 归一口径，给主进程大文件路径用（避免 readFileSync 阻塞 event loop）。 */
export async function readWithMetaAsync(
  absPath: string,
): Promise<{ content: string; lineEnding: LineEnding; mtimeMs: number }> {
  const [buf, st] = await Promise.all([readFile(absPath), stat(absPath)]);
  const mtimeMs = Math.floor(st.mtimeMs);

  let content: string;
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    content = buf.toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf);
    swapped.swap16();
    content = swapped.toString('utf16le');
  } else {
    content = buf.toString('utf-8');
  }

  const lineEnding = detectLineEndings(content.slice(0, 4096));
  return { content: normalizeDecoded(content), lineEnding, mtimeMs };
}

/** Math.floor(statSync.mtimeMs)——抹亚毫秒精度，避免快速读写假阳性（移植 claude code）。 */
export function floorMtime(absPath: string): number {
  return Math.floor(statSync(absPath).mtimeMs);
}

/**
 * diff 预览大小闸（字符）。超大文件（如 deck 生成的大 HTML）整篇覆盖时，Myers diff 是 O(n·d)，
 * d（差异量）在整篇重写下接近 n → 计算可能秒级卡顿、diff 字符串达数 MB 撑爆审批卡。超过则跳过。
 */
export const DIFF_PREVIEW_MAX_BYTES = 512 * 1024;

/** 旧→新 unified diff，供审批卡视觉预览（claude code 同源 createTwoFilesPatch）。超大文件跳过。 */
export function makePatch(oldText: string, newText: string, path: string): string {
  if (oldText.length > DIFF_PREVIEW_MAX_BYTES || newText.length > DIFF_PREVIEW_MAX_BYTES) {
    return `（文件较大，省略 diff 预览：旧 ${oldText.length} 字符 → 新 ${newText.length} 字符）`;
  }
  return createTwoFilesPatch(path, path, oldText, newText, undefined, undefined, { context: 3 });
}

/** CRLF 模式先把已有 CRLF 归一为 LF 再整体转换，避免 content 自带 \r\n 时 join 后变 \r\r\n。 */
function applyLineEnding(content: string, lineEnding: LineEnding): string {
  if (lineEnding !== 'CRLF') return content;
  return content.replaceAll('\r\n', '\n').split('\n').join('\r\n');
}

/** 统计样本里 CRLF / LF 各自出现次数，多者为该文件风格（移植 claude code detectLineEndingsForString）。 */
function detectLineEndings(sample: string): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === '\n') {
      if (i > 0 && sample[i - 1] === '\r') crlf++;
      else lf++;
    }
  }
  return crlf > lf ? 'CRLF' : 'LF';
}
