/**
 * Deck commitScheduler 防抖 smoke
 *
 * 验证：
 * 1. scheduleInlineEditCommit 在 PENDING_DELAY_MS 内多次调用 → 只 commit 一次
 * 2. flushPending 立即触发
 * 3. 多 pageIndex 累积进 summary
 *
 * 不用 fake timers——直接把 PENDING_DELAY_MS 短路调用 flushPending 来验证
 * commit 路径接通；真实定时器路径走 setTimeout 行为，比 fake timers 更接近生产。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDeck } from '../../electron/main/deck/store';
import { initManifest, listVersions } from '../../electron/main/deck/history';
import {
  scheduleInlineEditCommit,
  flushPending,
  flushAllPending,
  hasPending,
  __resetForTest,
} from '../../electron/main/deck/commitScheduler';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function main() {
  __resetForTest();

  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'deck-sched-'));
  const projectPath = join(tmpRoot, 'p');
  await fs.mkdir(projectPath, { recursive: true });
  const deck = await createDeck({ projectId: 'prj_sched', projectPath, name: 'sched-deck' });
  await initManifest(deck.id, '<section class="slide"><h1>hello</h1></section>');

  // case 1: 没排过任何 commit → hasPending=false
  assert(!hasPending(deck.id), 'hasPending 初始 false');

  // case 2: 排 3 次 → 状态仍 pending（未到时限）
  scheduleInlineEditCommit(deck.id, 0);
  scheduleInlineEditCommit(deck.id, 1);
  scheduleInlineEditCommit(deck.id, 2);
  assert(hasPending(deck.id), 'schedule 后 hasPending=true');

  // 改 index.html 让 commit 有 diff
  await fs.writeFile(
    join(deck.path, 'index.html'),
    '<section class="slide"><h1>hello world</h1></section>',
    'utf-8',
  );

  // case 3: flushPending 立即触发 + 默认 summary 含累积 pages（pageIndex 0-based, summary 1-based）
  scheduleInlineEditCommit(deck.id, 5);
  scheduleInlineEditCommit(deck.id, 7);
  await flushPending(deck.id);
  assert(!hasPending(deck.id), 'flushPending 后 hasPending=false');

  const versions = await listVersions(deck.id);
  // initial v001 + 防抖 commit v002 = 2 条
  assert(versions.length === 2, `listVersions 应 2 条（initial + 防抖 commit），实际 ${versions.length}`);
  assert(versions[1].kind === 'inline', '防抖 commit kind=inline');
  // 累积 pages = {0,1,2,5,7}（前 3 次已合并）；summary "第 1, 2, 3, 6, 8 页"
  assert(/第.+页/.test(versions[1].summary), 'summary 含"第 X 页"格式');
  assert(versions[1].summary.includes('1') && versions[1].summary.includes('8'), 'summary 含累积 pages');

  // case 4: flushPending 在没 pending 时是 no-op
  await flushPending(deck.id);
  assert(true, 'flush 无 pending 不报错（no-op）');

  // case 5 (N2)：flushAllPending 退出前 flush 所有 deck 的 pending
  const deck2 = await createDeck({ projectId: 'prj_sched', projectPath, name: 'sched-deck-2' });
  await initManifest(deck2.id, '<section class="slide"><h1>two</h1></section>');
  await fs.writeFile(
    join(deck.path, 'index.html'),
    '<section class="slide"><h1>hello again</h1></section>',
    'utf-8',
  );
  await fs.writeFile(
    join(deck2.path, 'index.html'),
    '<section class="slide"><h1>two changed</h1></section>',
    'utf-8',
  );
  scheduleInlineEditCommit(deck.id, 0);
  scheduleInlineEditCommit(deck2.id, 0);
  assert(hasPending(deck.id) && hasPending(deck2.id), '两 deck 都 pending');
  await flushAllPending();
  assert(!hasPending(deck.id) && !hasPending(deck2.id), 'flushAllPending 后两 deck 都不 pending');
  assert((await listVersions(deck2.id)).length === 2, 'deck2 也落了防抖 commit');

  __resetForTest();

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
