/**
 * read_file smoke
 *
 * 验证 v0.4 read_file 工具的沙箱边界 + 读盘行为：
 * - 非绝对路径 / 空路径拒绝
 * - 不在允许根下拒绝（系统路径、跨用户）
 * - 在 .tool-cache/ 下读成功
 * - ENOENT 返回 isError 而不抛
 * - persistPolicy='never'——本身不会被记录为待落盘工具
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeReadFileTool } from '../../electron/main/agent/agentTools/readFile';
import { conversationToolCacheDir, userDir } from '../../electron/main/runtime/paths';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import type { ToolContext } from '@shared/agent/backend';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== read_file smoke ===');

const tool = makeReadFileTool();

// ─── persistPolicy 标记回归 ──────────────────────────────
assert(tool.persistPolicy === 'never', "read_file.persistPolicy === 'never'");

// ─── 准备 ctx + 一个 .tool-cache/ 文件 ─────────────────
// 用真实 ownerId（'local-user'）+ ensureDefaultAgent 建出来的 agent
const agent = await ensureDefaultAgent();
const OWNER = 'local-user';
const AGENT = agent.id;
const CONV = 'c1';

const cacheDir = conversationToolCacheDir(OWNER, AGENT, CONV);
await fs.mkdir(cacheDir, { recursive: true });
const cachePath = join(cacheDir, 'call_x.md');
await fs.writeFile(cachePath, '# 工具结果全文\n这是 web_fetch 的全部内容', 'utf-8');

const ctx: ToolContext = {
  conversationId: CONV,
  agentId: AGENT,
  ownerId: OWNER,
  usage: 'twinMain',
  approvalMode: 'work',
    abortSignal: new AbortController().signal,
};

// ─── 非法入参 ────────────────────────────────────────
const r0 = await tool.execute({}, ctx);
assert(r0.isError === true, '空 input → isError', r0.text);

const r1 = await tool.execute({ path: '' }, ctx);
assert(r1.isError === true, '空 path → isError', r1.text);

const r2 = await tool.execute({ path: 'relative/path' }, ctx);
assert(r2.isError === true, '相对路径 → isError', r2.text);
assert(r2.text.includes('绝对路径'), '相对路径错误文案含 "绝对路径"', r2.text);

// ─── 不在允许根下 ────────────────────────────────────
const r3 = await tool.execute({ path: '/etc/passwd' }, ctx);
assert(r3.isError === true, '/etc/passwd → isError', r3.text);
assert(r3.text.includes('不在允许'), '越界错误文案对', r3.text);

// 跨用户：ORU_DIR/users/other-uid/...
const otherUserPath = join(userDir('other-uid'), 'some-file.txt');
const r4 = await tool.execute({ path: otherUserPath }, ctx);
assert(r4.isError === true, '跨用户 path → isError', r4.text);

// ─── 在 .tool-cache/ 下读成功 ────────────────────────
const r5 = await tool.execute({ path: cachePath }, ctx);
assert(r5.isError !== true, '.tool-cache/ 文件读成功', r5.text.slice(0, 80));
assert(r5.text.includes('工具结果全文'), '回读内容正确');

// ─── 整读后守卫放行 overwrite（read 改造接通 fileState）──
const { checkGuard } = await import('../../electron/main/agent/conversationFileState');
assert(checkGuard(CONV, cachePath, 'overwrite') === 'ok', '整读后 checkGuard(overwrite) === ok');

// ─── ENOENT ──────────────────────────────────────────
const r6 = await tool.execute({ path: join(cacheDir, 'nonexistent.txt') }, ctx);
assert(r6.isError === true, '不存在文件 → isError', r6.text);
assert(r6.text.includes('不存在'), 'ENOENT 文案对');

// ─── 系统 tmp 路径（非 .tool-cache 也非沙盒）────────
const tmpFile = join(tmpdir(), `read-file-smoke-${Date.now()}.txt`);
await fs.writeFile(tmpFile, 'tmp content', 'utf-8');
const r7 = await tool.execute({ path: tmpFile }, ctx);
assert(r7.isError === true, '系统 tmp 路径 → isError（非沙盒）', r7.text);

// 清理
await fs.unlink(tmpFile);

const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== read_file smoke: ${RESULTS.length - failed.length}/${RESULTS.length} PASS ===`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL: ${r.name} — ${r.detail ?? ''}`);
  process.exit(1);
}
