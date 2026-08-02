/**
 * grep + glob 只读搜索 smoke（Task 3.55）
 *
 * - grep 按内容命中返回结构化（文件:行:匹配）
 * - grep head_limit 截断 + 标注
 * - grep 排除 .git
 * - glob 按 pattern 命中 + 按 mtime 倒序 + 上限截断
 * - 白名单外 path → isError
 */
import './__smoke_isolate__';
import { promises as fs, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { makeGrepTool } from '../../electron/main/agent/agentTools/grep';
import { makeGlobTool } from '../../electron/main/agent/agentTools/glob';
import { conversationToolCacheDir } from '../../electron/main/runtime/paths';
import { ensureDefaultAgent } from '../../electron/main/agent/store/agents';
import type { ToolContext } from '@shared/agent/backend';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== grep + glob smoke ===');

const agent = await ensureDefaultAgent();
const OWNER = 'local-user';
const CONV = 'search-conv';
const ctx: ToolContext = {
  conversationId: CONV,
  agentId: agent.id,
  ownerId: OWNER,
  usage: 'twinMain',
  approvalMode: 'work',
  abortSignal: new AbortController().signal,
};

const root = join(conversationToolCacheDir(OWNER, agent.id, CONV), 'searchroot');
await fs.rm(root, { recursive: true, force: true });
await fs.mkdir(join(root, 'sub'), { recursive: true });
await fs.mkdir(join(root, '.git'), { recursive: true });
await fs.writeFile(join(root, 'a.md'), '报销流程说明\n第二行', 'utf-8');
await fs.writeFile(join(root, 'sub', 'b.txt'), '无关内容\n这里也讲报销流程\n尾行', 'utf-8');
await fs.writeFile(join(root, 'c.md'), '完全无关', 'utf-8');
await fs.writeFile(join(root, '.git', 'config'), '报销流程 不该被搜到', 'utf-8');

const grep = makeGrepTool();
const glob = makeGlobTool();

// ① grep content 命中返回结构化（文件:行:匹配）
const rc = await grep.execute({ pattern: '报销流程', path: root, output_mode: 'content' }, ctx);
assert(rc.isError !== true, '① grep content 成功', rc.text);
assert(/a\.md:1:.*报销流程/.test(rc.text), '① 结构化 文件:行:匹配（a.md:1）', rc.text);
assert(/b\.txt:2:.*报销流程/.test(rc.text), '① 命中子目录 b.txt:2');

// ③ grep 排除 .git
assert(!rc.text.includes('.git'), '③ grep 排除 .git 目录');

// files_with_matches 模式（默认）
const rf = await grep.execute({ pattern: '报销流程', path: root }, ctx);
assert(rf.text.includes('a.md') && rf.text.includes('b.txt') && !rf.text.includes('c.md'), 'files_with_matches 只列命中文件');

// glob 过滤 + 无匹配
const rno = await grep.execute({ pattern: 'zzz不存在zzz', path: root }, ctx);
assert(rno.isError !== true && rno.text.includes('无匹配'), 'grep 无匹配返回提示');

// ② grep head_limit 截断
const manyDir = join(root, 'many');
await fs.mkdir(manyDir, { recursive: true });
await Promise.all(Array.from({ length: 10 }, (_, i) => fs.writeFile(join(manyDir, `m${i}.txt`), 'needle', 'utf-8')));
const rlim = await grep.execute({ pattern: 'needle', path: manyDir, output_mode: 'files_with_matches', head_limit: 3 }, ctx);
assert(rlim.text.includes('已截断') && (rlim.structured as { truncated?: boolean })?.truncated === true, '② grep head_limit 截断标注');

// ②b 单行大 HTML（超长行）：必须照常命中，content 模式只回片段不吐整行
const bigDir = join(root, 'big');
await fs.mkdir(bigDir, { recursive: true });
const oneLine = 'x'.repeat(50000) + '报销流程' + 'y'.repeat(50000);
await fs.writeFile(join(bigDir, 'page.html'), oneLine, 'utf-8');
const rbigF = await grep.execute({ pattern: '报销流程', path: bigDir }, ctx);
assert(rbigF.text.includes('page.html'), '②b 单行大 HTML 仍能命中（files_with_matches）', rbigF.text);
const rbigC = await grep.execute({ pattern: '报销流程', path: bigDir, output_mode: 'content' }, ctx);
assert(rbigC.text.includes('报销流程') && rbigC.text.length < 1000, '②b content 模式只回片段不吐 10 万字整行', `len=${rbigC.text.length}`);

// ④ glob 按 pattern 命中 + mtime 倒序
// 设置 mtime：c.md 最新 → 应排在 a.md 前
utimesSync(join(root, 'a.md'), new Date('2020-01-01'), new Date('2020-01-01'));
utimesSync(join(root, 'c.md'), new Date('2024-01-01'), new Date('2024-01-01'));
const rg = await glob.execute({ pattern: '*.md', path: root }, ctx);
assert(rg.isError !== true, '④ glob 成功', rg.text);
assert(rg.text.includes('a.md') && rg.text.includes('c.md'), '④ glob 命中 *.md');
assert(rg.text.indexOf('c.md') < rg.text.indexOf('a.md'), '④ glob 按 mtime 倒序（c.md 较新在前）', rg.text);
// 递归 glob
const rgr = await glob.execute({ pattern: '**/*.txt', path: root }, ctx);
assert(rgr.text.includes('b.txt'), '④ glob 递归 **/*.txt 命中子目录');
// glob 排除 .git
assert(!rgr.text.includes('.git'), '④ glob 排除 .git');

// ⑤ 白名单外 path → isError
const rout = await grep.execute({ pattern: 'x', path: '/etc' }, ctx);
assert(rout.isError === true && rout.text.includes('允许'), '⑤ grep 白名单外 → isError', rout.text);
const rout2 = await glob.execute({ pattern: '*', path: '/etc' }, ctx);
assert(rout2.isError === true && rout2.text.includes('允许'), '⑤ glob 白名单外 → isError', rout2.text);

const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== grep + glob smoke: ${RESULTS.length - failed.length}/${RESULTS.length} PASS ===`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL: ${r.name} — ${r.detail ?? ''}`);
  process.exit(1);
}
