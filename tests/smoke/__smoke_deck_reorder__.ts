/**
 * Deck 后端 reorderSlides smoke
 *
 * 保留页间原始间隙——恒等重排重建出与原文逐字节相同的 HTML，不产生伪版本变更。
 * annotation 的 pageIndex 越界（指向已删页）时不写 -1，保持原值。
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDeck } from '../../electron/main/deck/store';
import { initManifest } from '../../electron/main/deck/history';
import { deckIndexPath } from '../../electron/main/deck/pathResolver';
import { reorderSlides } from '../../electron/main/deck/reorderSlides';
import { readAnnotations, writeAnnotations } from '../../electron/main/deck/annotations';
import { segmentSlidesWithRanges } from '../../electron/main/deck/deckModel';
import type { Annotation } from '@shared/types';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

// 页间用非 '\n' 的间隙（缩进 + 注释），专门暴露 '\n' 硬拼的伪 diff
const HTML =
  '<section class="slide"><h1>A</h1></section>\n\n  <!-- gap1 -->\n  ' +
  '<section class="slide"><h1>B</h1></section>\n\t<!-- gap2 -->\t' +
  '<section class="slide"><h1>C</h1></section>';

function ann(id: string, pageIndex: number): Annotation {
  return {
    id,
    comment: `c-${id}`,
    cropPath: '',
    htmlSnippet: '',
    text: '',
    locator: { scrollY: 0, rect: { x: 0, y: 0, w: 1, h: 1 }, pageIndex },
    status: 'pending',
    createdAt: 1,
    updatedAt: 1,
  };
}

async function main() {
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'deck-reorder-'));
  const projectPath = join(tmpRoot, 'p');
  await fs.mkdir(projectPath, { recursive: true });

  // ── M10：恒等重排字节不变 ──
  const d1 = await createDeck({ projectId: 'prj_re', projectPath, name: 'reorder-identity' });
  await initManifest(d1.id, HTML);
  const before1 = await fs.readFile(deckIndexPath(d1.path), 'utf-8');
  const r1 = await reorderSlides({ artifactId: d1.id, newOrder: [0, 1, 2], broadcast: () => {} });
  assert(r1.ok, 'identity reorder 返回 ok');
  const after1 = await fs.readFile(deckIndexPath(d1.path), 'utf-8');
  assert(after1 === before1, '恒等重排后 index.html 逐字节不变（M10：不再 \\n 硬拼）', `len ${before1.length}->${after1.length}`);

  // ── 非恒等重排：交换前两页，间隙位置不变、内容切得回 3 页 ──
  const d2 = await createDeck({ projectId: 'prj_re', projectPath, name: 'reorder-swap' });
  await initManifest(d2.id, HTML);
  const r2 = await reorderSlides({ artifactId: d2.id, newOrder: [1, 0, 2], broadcast: () => {} });
  assert(r2.ok, 'swap reorder 返回 ok');
  const after2 = await fs.readFile(deckIndexPath(d2.path), 'utf-8');
  const seg2 = segmentSlidesWithRanges(after2);
  assert(seg2.length === 3, `重排后仍切出 3 页，实际 ${seg2.length}`);
  assert(/>B<\/h1>/.test(seg2[0].html) && />A<\/h1>/.test(seg2[1].html), '前两页内容确实交换（B,A,C）');
  assert(after2.includes('<!-- gap1 -->') && after2.includes('<!-- gap2 -->'), '原始页间间隙保留');

  // ── L2：越界 pageIndex 不写 -1 ──
  const d3 = await createDeck({ projectId: 'prj_re', projectPath, name: 'reorder-annot' });
  await initManifest(d3.id, HTML);
  await writeAnnotations(d3.id, [ann('ann_p0', 0), ann('ann_stale', 5)]);
  const r3 = await reorderSlides({ artifactId: d3.id, newOrder: [1, 0, 2], broadcast: () => {} });
  assert(r3.ok, 'reorder（带注释）返回 ok');
  const annots = await readAnnotations(d3.id);
  const p0 = annots.find((a) => a.id === 'ann_p0');
  const stale = annots.find((a) => a.id === 'ann_stale');
  assert(p0?.locator.pageIndex === 1, `page-0 注释 remap 到 1，实际 ${p0?.locator.pageIndex}`);
  assert(stale?.locator.pageIndex === 5, `越界注释保持 5（不写 -1），实际 ${stale?.locator.pageIndex}`);

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
