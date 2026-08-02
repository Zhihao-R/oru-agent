/**
 * read_file 分段读 + dedup smoke（Task 2.2）
 *
 * - 默认整读 isPartialView=false，cat -n 行号
 * - offset/limit 部分读 isPartialView=true，只返回该段，行号从 offset 起算
 * - dedup：同 path+同范围+mtime 未变 → 返回 stub 不重发全文
 * - 整读超大小闸 → isError 引导用 offset/limit
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { makeReadFileTool } from '../../electron/main/agent/agentTools/readFile';
import { peekFileState } from '../../electron/main/agent/conversationFileState';
import { conversationToolCacheDir } from '../../electron/main/runtime/paths';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import type { ToolContext } from '@shared/agent/backend';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== read_file range + dedup smoke ===');

const tool = makeReadFileTool();
const agent = await ensureDefaultAgent();
const OWNER = 'local-user';
const CONV = 'range-conv';
const ctx: ToolContext = {
  conversationId: CONV,
  agentId: agent.id,
  ownerId: OWNER,
  usage: 'twinMain',
  approvalMode: 'work',
  abortSignal: new AbortController().signal,
};

const cacheDir = conversationToolCacheDir(OWNER, agent.id, CONV);
await fs.mkdir(cacheDir, { recursive: true });

// 一个 10 行文件
const f = join(cacheDir, 'lines.txt');
const tenLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
await fs.writeFile(f, tenLines, 'utf-8');

// ① 默认整读
const r1 = await tool.execute({ path: f }, ctx);
assert(r1.isError !== true, '① 整读成功', r1.text);
assert(r1.text.startsWith('1\t'), '① cat -n 行号从 1 起', r1.text.slice(0, 20));
assert(r1.text.includes('line 10'), '① 整读含末行');
assert(peekFileState(CONV, f)?.isPartialView === false, '① 整读 isPartialView=false');

// ② offset/limit 部分读
const r2 = await tool.execute({ path: f, offset: 4, limit: 3 }, ctx);
assert(r2.isError !== true, '② 部分读成功', r2.text);
assert(r2.text.startsWith('4\t'), '② 行号从 offset=4 起算', r2.text.slice(0, 20));
assert(r2.text.includes('line 4') && r2.text.includes('line 6'), '② 只返回 4~6 段');
assert(!r2.text.includes('line 7') && !r2.text.includes('line 1\t'), '② 不含范围外行');
assert(peekFileState(CONV, f)?.isPartialView === true, '② 部分读 isPartialView=true');
assert(peekFileState(CONV, f)?.offset === 4 && peekFileState(CONV, f)?.limit === 3, '② fileState 记录 offset/limit');

// ③ dedup：再读同范围（mtime 未变）→ stub
const r3 = await tool.execute({ path: f, offset: 4, limit: 3 }, ctx);
assert(r3.isError !== true && r3.text.includes('文件未变'), '③ 同范围重读 → dedup stub', r3.text.slice(0, 60));
// 不同范围不 dedup
const r3b = await tool.execute({ path: f, offset: 1, limit: 2 }, ctx);
assert(!r3b.text.includes('文件未变') && r3b.text.startsWith('1\t'), '③ 不同范围不 dedup');

// ④ 多行大文件整读超闸：不报红，直接回开头 + offset 续读提示（省一次往返）
const big = join(cacheDir, 'big.txt');
const bigContent = Array.from({ length: 2500 }, (_, i) => `row ${i}`).join('\n');
await fs.writeFile(big, bigContent, 'utf-8');
const r4 = await tool.execute({ path: big }, ctx);
assert(r4.isError !== true, '④ 整读超行数闸 → 不报红');
assert(r4.text.includes('row 0') && r4.text.includes('offset='), '④ 回开头内容 + offset 续读提示', r4.text.slice(0, 80));
assert(!r4.text.includes('row 2499'), '④ 只回开头、未吐全文');
assert(peekFileState(CONV, big)?.isPartialView === true, '④ 标 partial（整覆盖前须续读）');
// 但显式分段读放开
const r4b = await tool.execute({ path: big, offset: 1, limit: 100 }, ctx);
assert(r4b.isError !== true && r4b.text.includes('row 0'), '④ 显式分段读放开大小闸');

// ⑤ 单行/超长行大文件（minified HTML）：按行切不开 → 指向 grep，不 dump 字节
const minified = join(cacheDir, 'deck.html');
const oneHugeLine = '<section class="slide">' + 'x'.repeat(300 * 1024) + '</section>'; // 单行 >256KB
await fs.writeFile(minified, oneHugeLine, 'utf-8');
const r5 = await tool.execute({ path: minified }, ctx);
assert(r5.text.includes('grep'), '⑤ 单行超长 → 提示改用 grep 定位', r5.text.slice(0, 100));
assert(!r5.text.includes('x'.repeat(1000)), '⑤ 不 dump 那坨字节（不塞爆上下文）');

const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== read_file range smoke: ${RESULTS.length - failed.length}/${RESULTS.length} PASS ===`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL: ${r.name} — ${r.detail ?? ''}`);
  process.exit(1);
}
