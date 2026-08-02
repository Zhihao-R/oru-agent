/**
 * Artifact history AI 工具 smoke：artifact_history_list / artifact_history_checkout
 *
 * 验证：
 * 1. 没 active deck 时返回 isError
 * 2. list 返回所有版本按时间倒序 + 标记当前
 * 3. checkout 成功路径
 * 4. checkout 不存在版本 → error
 * 5. checkout 引用 missing image 且非 force → error 含 missingImages 列表
 * 6. dirty + checkout 自动 protective commit
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDeck, setActiveDeckId } from '../../electron/main/deck/store';
import { initManifest, commitVersion, listVersions } from '../../electron/main/deck/history';
import {
  makeArtifactHistoryListTool,
  makeArtifactHistoryCheckoutTool,
} from '../../electron/main/agent/agentTools/deckHistory';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function main() {
  const listTool = makeArtifactHistoryListTool();
  const checkoutTool = makeArtifactHistoryCheckoutTool();
  const ctx = {
    conversationId: 'cnv_test',
    agentId: 'agt_test',
    ownerId: 'local-user',
    approvalMode: 'work',
    usage: 'twinMain' as const,
    abortSignal: new AbortController().signal,
  };

  // ─── case 1: 没 active deck ───
  setActiveDeckId(null);
  const r1 = await listTool.execute({}, ctx);
  assert(r1.isError === true, '没 active deck 时 list 报错');
  const r2 = await checkoutTool.execute({ version_id: 'v001' }, ctx);
  assert(r2.isError === true, '没 active deck 时 checkout 报错');

  // ─── 准备一个 deck 含 3 个版本 ───
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'deck-htool-'));
  const projectPath = join(tmpRoot, 'p');
  await fs.mkdir(projectPath, { recursive: true });
  const deck = await createDeck({ projectId: 'prj_x', projectPath, name: 'test deck' });
  await initManifest(deck.id, '<section class="slide"><h1>v1</h1></section>');
  await fs.writeFile(join(deck.path, 'index.html'), '<section class="slide"><h1>v2</h1></section>');
  await commitVersion(deck.id, 'batch', '第二版');
  await fs.writeFile(join(deck.path, 'index.html'), '<section class="slide"><h1>v3</h1></section>');
  await commitVersion(deck.id, 'ai', '第三版');

  setActiveDeckId(deck.id);

  // ─── case 2: list ───
  const r3 = await listTool.execute({}, ctx);
  assert(!r3.isError, 'list 成功');
  assert(r3.text!.includes('v003'), 'list 含 v003');
  assert(r3.text!.includes('v002'), 'list 含 v002');
  assert(r3.text!.includes('v001'), 'list 含 v001');
  assert(r3.text!.includes('[当前]'), 'list 标当前版本');
  // 倒序：v003 应在 v001 之前出现
  const idxV3 = r3.text!.indexOf('v003');
  const idxV1 = r3.text!.indexOf('v001');
  assert(idxV3 < idxV1, 'list 按时间倒序（v003 先于 v001）');

  // ─── case 3: checkout v001 ───
  const r4 = await checkoutTool.execute({ version_id: 'v001' }, ctx);
  assert(!r4.isError, 'checkout v001 成功');
  const cur = await fs.readFile(join(deck.path, 'index.html'), 'utf-8');
  assert(cur.includes('<h1>v1</h1>'), 'checkout 后 index.html 切回 v001 内容');

  // ─── case 4: checkout 不存在版本 → isError text ───
  const r5 = await checkoutTool.execute({ version_id: 'v999' }, ctx);
  assert(r5.isError === true, 'checkout 不存在版本返回 isError');
  assert(r5.text!.includes('v999'), '错误文案含版本 id');

  // ─── case 5: checkout 含 missing image 不 force ───
  await fs.writeFile(
    join(deck.path, 'index.html'),
    '<section class="slide"><img src="images/missing.png"></section>',
  );
  await commitVersion(deck.id, 'ai', '加张图');   // v004
  // 回到 v001
  await checkoutTool.execute({ version_id: 'v001' }, ctx);
  // 试 checkout v004（含 missing 图）
  const r6 = await checkoutTool.execute({ version_id: 'v004' }, ctx);
  assert(r6.isError === true, 'checkout missing image 非 force 时报错');
  assert(r6.text!.includes('missing.png'), '错误含 missing.png 文件名');

  // case 6: force=true 时强制 checkout
  const r7 = await checkoutTool.execute({ version_id: 'v004', force: true }, ctx);
  assert(!r7.isError, 'checkout force=true 成功');

  // case 7: dirty + checkout → 自动 protective commit
  setActiveDeckId(deck.id);
  await fs.writeFile(join(deck.path, 'index.html'), '<section class="slide"><h1>dirty</h1></section>');
  const versionsBefore = await listVersions(deck.id);
  await checkoutTool.execute({ version_id: 'v001' }, ctx);
  const versionsAfter = await listVersions(deck.id);
  assert(versionsAfter.length === versionsBefore.length + 1, 'dirty checkout 多了一个 protective commit');
  const protectiveVer = versionsAfter[versionsAfter.length - 1];
  assert(protectiveVer.kind === 'protective', '新版本 kind=protective');

  const failed = RESULTS.filter((r) => !r.ok);
  console.log('');
  console.log(`Total: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    for (const f of failed) console.error(` - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke fatal:', e);
  process.exit(1);
});
