/**
 * 行内编辑内容定位回写 smoke —— applyInlineEdit（6.2）
 *
 * 钉的真风险（泛化外部静态 HTML：源里没 data-edit-id，靠 oldText 子串唯一性定位）：
 * - (a) 唯一命中：oldText 在源里恰好 1 次 → 替换写回 + 落盘内容正确、源其余不变、返回 ok
 * - (b) 多命中：oldText 出现 >1 次 → reason 'ambiguous' 拒绝、index.html 一字不动
 * - (c) 零命中：oldText 源里没有（动态渲染场景）→ reason 'not-found' 拒绝、index.html 不变
 * - (d) data-edit-id 快路径：带 markerId → 正则定位整段 inner 替换（即便 oldText 歧义也精准命中）
 */
import './__smoke_isolate__';

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createDeck, resolveDeckPath } from '../../electron/main/deck/store';
import { initManifest } from '../../electron/main/deck/history';
import { deckIndexPath } from '../../electron/main/deck/pathResolver';
import { applyInlineEdit } from '../../electron/main/deck/applyInlineEdit';

const RESULTS: Array<{ name: string; ok: boolean; detail?: string }> = [];
function assert(cond: boolean, name: string, detail?: string): void {
  RESULTS.push({ name, ok: cond, detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + String(detail).slice(0, 300) : ''}`);
}

async function newDeck(projectPath: string, name: string, html: string): Promise<string> {
  const deck = await createDeck({ projectId: 'prj_ie', projectPath, name });
  await initManifest(deck.id, html);
  return deck.id;
}

async function main() {
  const tmpRoot = await fs.mkdtemp(join(tmpdir(), 'artifact-inline-edit-'));
  const projectPath = join(tmpRoot, 'prj');
  await fs.mkdir(projectPath, { recursive: true });

  // ─── (a) 唯一命中 → 替换写回 ───
  {
    const html = `<!doctype html><html><body>
<section class="slide"><h1>标题一</h1><p>这里有个错别字：苹果</p></section>
</body></html>`;
    const id = await newDeck(projectPath, 'ie_unique', html);
    const indexPath = deckIndexPath(await resolveDeckPath(id));

    const r = await applyInlineEdit({
      artifactId: id,
      markerId: null,
      oldText: '这里有个错别字：苹果',
      newText: '这里有个错别字：香蕉',
      pageIndex: 0,
    });
    assert(r.ok === true, '(a) 唯一命中 → ok:true');
    const after = await fs.readFile(indexPath, 'utf-8');
    assert(after.includes('这里有个错别字：香蕉'), '(a) 新文本已落盘');
    assert(!after.includes('苹果'), '(a) 旧文本已被替换');
    assert(after.includes('<h1>标题一</h1>'), '(a) 源其余部分不变');
  }

  // ─── (b) 多命中 → ambiguous 拒绝 ───
  {
    const html = `<!doctype html><html><body>
<section class="slide"><p>重复文本</p><p>重复文本</p></section>
</body></html>`;
    const id = await newDeck(projectPath, 'ie_ambig', html);
    const indexPath = deckIndexPath(await resolveDeckPath(id));
    const before = await fs.readFile(indexPath, 'utf-8');

    const r = await applyInlineEdit({
      artifactId: id,
      markerId: null,
      oldText: '重复文本',
      newText: '改后文本',
      pageIndex: 0,
    });
    assert(r.ok === false && r.reason === 'ambiguous', '(b) 多命中 → reason ambiguous');
    const after = await fs.readFile(indexPath, 'utf-8');
    assert(before === after, '(b) 拒绝时 index.html 一字不动');
  }

  // ─── (c) 零命中 → not-found 拒绝 ───
  {
    const html = `<!doctype html><html><body>
<section class="slide"><p>静态内容</p></section>
</body></html>`;
    const id = await newDeck(projectPath, 'ie_notfound', html);
    const indexPath = deckIndexPath(await resolveDeckPath(id));
    const before = await fs.readFile(indexPath, 'utf-8');

    const r = await applyInlineEdit({
      artifactId: id,
      markerId: null,
      oldText: '运行时才渲染的文本', // 源里没有（模拟动态渲染 DOM≠源）
      newText: '随便改',
      pageIndex: 0,
    });
    assert(r.ok === false && r.reason === 'not-found', '(c) 零命中 → reason not-found');
    const after = await fs.readFile(indexPath, 'utf-8');
    assert(before === after, '(c) 拒绝时 index.html 不变');
  }

  // ─── (d) data-edit-id 快路径 → 正则定位替换 ───
  {
    // 故意让 oldText 在源里多次出现，验证快路径靠 markerId 精准命中（不被歧义阻断）
    const html = `<!doctype html><html><body>
<section class="slide"><p data-edit-id="el-7">同样的话</p><p>同样的话</p></section>
</body></html>`;
    const id = await newDeck(projectPath, 'ie_marker', html);
    const indexPath = deckIndexPath(await resolveDeckPath(id));

    const r = await applyInlineEdit({
      artifactId: id,
      markerId: 'el-7',
      oldText: '同样的话',
      newText: '被快路径改了',
      pageIndex: 0,
    });
    assert(r.ok === true, '(d) 快路径 → ok:true');
    const after = await fs.readFile(indexPath, 'utf-8');
    assert(
      after.includes('<p data-edit-id="el-7">被快路径改了</p>'),
      '(d) 仅 markerId 元素 inner 被替换',
    );
    assert(after.includes('<p>同样的话</p>'), '(d) 另一个同文本元素不受影响');
  }

  // ─── (e) newText 含 $ → 字面落盘（不被 String.replace 的 $&/$1 模式展开损坏）───
  {
    const html = `<!doctype html><html><body>
<section class="slide"><p>原价</p></section>
</body></html>`;
    const id = await newDeck(projectPath, 'ie_dollar', html);
    const indexPath = deckIndexPath(await resolveDeckPath(id));

    const r = await applyInlineEdit({
      artifactId: id,
      markerId: null,
      oldText: '原价',
      newText: '价格 $1 起（原 $&100）',
      pageIndex: 0,
    });
    assert(r.ok === true, '(e) newText 含 $ → ok:true');
    const after = await fs.readFile(indexPath, 'utf-8');
    assert(after.includes('价格 $1 起（原 $&100）'), '(e) $ 字面落盘，未被替换模式展开');
  }

  // ─── 汇总 ───
  const failed = RESULTS.filter((x) => !x.ok);
  console.log('');
  console.log(`Total: ${RESULTS.length}, Passed: ${RESULTS.length - failed.length}, Failed: ${failed.length}`);
  if (failed.length > 0) {
    console.error('Failures:');
    for (const f of failed) console.error(` - ${f.name}: ${f.detail ?? ''}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('smoke fatal error:', e);
  process.exit(1);
});
