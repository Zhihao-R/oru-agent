/**
 * persist.ts smoke
 *
 * 验证 v0.4 工具结果源头落盘的 4 个核心 API：
 * - shouldPersist：persistPolicy never / always / auto × (短/长) × tool=undefined 各分支
 * - writeToolCacheFile：路径准确、父目录自动建、字节准确
 * - buildPreview：短文本/长文本两种 + 提示行含 totalChars 和 path
 * - clearToolCacheForConversation：目录存在/不存在均不抛
 */
import './__smoke_isolate__';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import {
  PERSIST_TOKEN_THRESHOLD,
  PREVIEW_CHAR_LIMIT,
  shouldPersist,
  writeToolCacheFile,
  buildPreview,
  clearToolCacheForConversation,
} from '../../electron/main/agent/context/persist';
import { conversationToolCacheDir } from '../../electron/main/runtime/paths';
import type { AgentTool } from '@shared/agent/backend';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
}

console.log('=== persist smoke ===');

function mkTool(persistPolicy?: AgentTool['persistPolicy']): AgentTool {
  return {
    name: 'fake',
    description: '',
    inputSchema: {},
    persistPolicy,
    async execute() {
      return { text: '' };
    },
  };
}

// ─── shouldPersist ──────────────────────────────────────

const SHORT = '短文本';
// 构造一个估算 > 2000 token 的字符串：3000 个 ASCII 字符按 0.28 系数 ≈ 840 token，远不够；
// CJK 1.5 token/char,需 ~1400 个 CJK 才到 2100 token。给 1500 个汉字保险。
const LONG_CJK = '中'.repeat(1500); // 1500 * 1.5 = 2250 token > 2000

// 1. never：长短都不落
assert(shouldPersist(mkTool('never'), SHORT) === false, "never + short → false");
assert(shouldPersist(mkTool('never'), LONG_CJK) === false, "never + long → false");

// 2. always：长短都落
assert(shouldPersist(mkTool('always'), SHORT) === true, "always + short → true");
assert(shouldPersist(mkTool('always'), LONG_CJK) === true, "always + long → true");

// 3. auto + 短 → 不落
assert(shouldPersist(mkTool('auto'), SHORT) === false, "auto + short → false");
// 4. auto + 长 → 落
assert(shouldPersist(mkTool('auto'), LONG_CJK) === true, "auto + long → true");

// 5. tool=undefined → 当 auto 处理
assert(shouldPersist(undefined, SHORT) === false, "tool=undefined + short → false");
assert(shouldPersist(undefined, LONG_CJK) === true, "tool=undefined + long → true");

// 6. persistPolicy=undefined → 当 auto
assert(shouldPersist(mkTool(undefined), LONG_CJK) === true, "policy=undefined + long → true");

// ─── writeToolCacheFile ──────────────────────────────────

async function runFileIo() {
  const args = {
    ownerId: 'u1',
    agentId: 'twin',
    conversationId: 'c1',
    callId: 'call_abc123',
    ext: 'md',
    content: '# hello\nworld',
  };

  // 写入前目录不存在
  const dir = conversationToolCacheDir(args.ownerId, args.agentId, args.conversationId);
  assert(!existsSync(dir), 'writeToolCacheFile 前目录不存在');

  const path = await writeToolCacheFile(args);
  assert(path.endsWith(`${args.callId}.${args.ext}`), 'path 以 callId.ext 结尾', path);
  assert(path.startsWith(dir), 'path 在 .tool-cache/ 下', path);

  const back = await fs.readFile(path, 'utf-8');
  assert(back === args.content, '回读内容与写入一致');

  // 再写一遍：覆盖（不抛）
  await writeToolCacheFile({ ...args, content: 'overwritten' });
  const back2 = await fs.readFile(path, 'utf-8');
  assert(back2 === 'overwritten', '同 callId 重写覆盖');

  // ─── buildPreview ──────────────────────────────────────

  const shortDetail = '短内容 100 字以内';
  const shortPreview = buildPreview(shortDetail, path);
  assert(shortPreview.startsWith(shortDetail), '短文本预览以原文起始');
  assert(shortPreview.includes(`全文 ${shortDetail.length} 字符`), '短预览含 totalChars');
  assert(shortPreview.includes(path), '短预览含 path');

  // 长 detail
  const longDetail = 'A'.repeat(PREVIEW_CHAR_LIMIT + 500);
  const longPreview = buildPreview(longDetail, path);
  assert(longPreview.startsWith('A'.repeat(PREVIEW_CHAR_LIMIT)), '长文本预览取前 1500 字');
  assert(longPreview.includes(`全文 ${longDetail.length} 字符`), '长预览含 totalChars');
  assert(longPreview.includes(path), '长预览含 path');
  assert(longPreview.includes('调用 read_file'), '长预览含调用提示');
  assert(longPreview.length < longDetail.length, '长预览比原 detail 短');

  // ─── clearToolCacheForConversation ────────────────────

  assert(existsSync(dir), 'clear 前目录还在');
  await clearToolCacheForConversation({
    ownerId: args.ownerId,
    agentId: args.agentId,
    conversationId: args.conversationId,
  });
  assert(!existsSync(dir), 'clear 后目录已删');

  // 再 clear：不存在路径不抛
  await clearToolCacheForConversation({
    ownerId: args.ownerId,
    agentId: args.agentId,
    conversationId: args.conversationId,
  });
  assert(true, 'clear 不存在目录不抛');
}

// ─── 阈值常量回归 ────────────────────────────────────────
assert(PERSIST_TOKEN_THRESHOLD === 2000, 'PERSIST_TOKEN_THRESHOLD = 2000');
assert(PREVIEW_CHAR_LIMIT === 1500, 'PREVIEW_CHAR_LIMIT = 1500');

await runFileIo();

// ─── 汇总 ────────────────────────────────────────────────
const failed = RESULTS.filter((r) => !r.ok);
console.log(`\n=== persist smoke: ${RESULTS.length - failed.length}/${RESULTS.length} PASS ===`);
if (failed.length > 0) {
  for (const r of failed) console.log(`  FAIL: ${r.name}`);
  process.exit(1);
}
