/**
 * safeWrite 原子落盘内核 smoke
 *
 * 验证移植自 claude code 的落盘内核（electron/main/fs/safeWrite.ts）：
 * - 新建：父目录不存在自动 mkdir -p，内容正确
 * - 覆盖：保留原文件权限位（chmod 0o600 后覆盖，mode 不变）
 * - 换行符保真：CRLF 文件 readWithMeta 返回 'CRLF' 且 content 已归一为 \n；
 *   safeWrite 以 'CRLF' 写回，磁盘字节含 \r\n
 * - 原子写无 .tmp. 残留
 * - floorMtime = Math.floor(mtimeMs)
 * - makePatch 产出旧→新 diff 文本
 */
import { promises as fs, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { safeWrite, readWithMeta, floorMtime, makePatch } from '../../electron/main/fs/safeWrite';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== safeWrite atomic smoke ===');

const root = join(tmpdir(), `safe-write-smoke-${Date.now()}`);

// ① 新建：父目录不存在自动建 + 内容正确
const nested = join(root, 'a', 'b', 'c', 'note.md');
safeWrite(nested, '# 标题\n正文', 'LF');
assert(readFileSync(nested, 'utf-8') === '# 标题\n正文', '① 新建（父目录不存在）内容正确');

// ② 覆盖保留原 mode
const permFile = join(root, 'perm.txt');
safeWrite(permFile, 'v1', 'LF');
await fs.chmod(permFile, 0o600);
const modeBefore = statSync(permFile).mode & 0o777;
safeWrite(permFile, 'v2-overwrite', 'LF');
const modeAfter = statSync(permFile).mode & 0o777;
assert(readFileSync(permFile, 'utf-8') === 'v2-overwrite', '② 覆盖内容正确');
assert(modeBefore === 0o600 && modeAfter === 0o600, '② 覆盖保留原 mode 0o600', `before=${modeBefore.toString(8)} after=${modeAfter.toString(8)}`);

// ③ 换行符保真：先以 CRLF 写盘，readWithMeta 探回 CRLF 且 content 已归一
const crlfFile = join(root, 'crlf.txt');
safeWrite(crlfFile, 'line1\nline2\nline3', 'CRLF');
const rawBytes = readFileSync(crlfFile);
assert(rawBytes.includes(Buffer.from('\r\n')), '③ safeWrite CRLF 写回磁盘含 \\r\\n');
const meta = readWithMeta(crlfFile);
assert(meta.lineEnding === 'CRLF', '③ readWithMeta 探出 CRLF', meta.lineEnding);
assert(!meta.content.includes('\r'), '③ readWithMeta content 已归一为 \\n（无 \\r）');
assert(meta.content === 'line1\nline2\nline3', '③ content 正确');

// 反向：LF 文件探出 LF
const lfFile = join(root, 'lf.txt');
safeWrite(lfFile, 'a\nb\nc', 'LF');
assert(!readFileSync(lfFile).includes(Buffer.from('\r\n')), '③ LF 写回无 \\r\\n');
assert(readWithMeta(lfFile).lineEnding === 'LF', '③ readWithMeta 探出 LF');

// ④ 无 .tmp. 残留
const entries = await fs.readdir(root);
assert(!entries.some((e) => e.includes('.tmp.')), '④ 落盘后无 .tmp. 残留', entries.join(','));

// ⑤ floorMtime = Math.floor(mtimeMs)
assert(floorMtime(lfFile) === Math.floor(statSync(lfFile).mtimeMs), '⑤ floorMtime 抹亚毫秒');

// ⑥ makePatch 产出旧→新 diff
const patch = makePatch('hello\nworld', 'hello\nworld!', lfFile);
assert(patch.includes('-world') && patch.includes('+world!'), '⑥ makePatch 含 -旧/+新行', patch.slice(0, 120));

// ⑦ 超大文件（大 HTML 等）跳过 diff 计算，返回省略说明而非卡死/产出数 MB diff
const huge = 'x'.repeat(600 * 1024);
const hugePatch = makePatch(huge, huge + 'y', lfFile);
assert(hugePatch.includes('省略 diff 预览'), '⑦ 超大文件 makePatch 省略 diff', hugePatch.slice(0, 60));

// 清理
await fs.rm(root, { recursive: true, force: true });

const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== safeWrite atomic smoke: ${RESULTS.length - failed.length}/${RESULTS.length} PASS ===`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL: ${r.name} — ${r.detail ?? ''}`);
  process.exit(1);
}
