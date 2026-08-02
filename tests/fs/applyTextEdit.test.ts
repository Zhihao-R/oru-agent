/**
 * applyTextEdit 内核单测——文件级文字写回（定位逻辑与 deck/applyInlineEdit 等价）：
 *  - 唯一文本 → ok，文件已替换
 *  - 重复文本 → ambiguous，文件未变
 *  - 不存在文本 → not-found，文件未变
 *  - data-edit-id 快路径 → 避开同文本歧义，只改带 marker 的元素
 *  - markerId 给了但文件无该 id → 落慢路径靠 oldText 唯一性兜底（与 deck 同构，不直接报错）
 *  - newText 含 $&/$1 → 字面写入，不被当替换模式
 *  - 过期 expectedMtimeMs → conflict，文件未变
 *  - 同文件并发两次合法编辑（不同 oldText）→ 串行、都落、无丢更新
 *  - 文件不存在 → io
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applyTextEdit } from '../../electron/main/fs/applyTextEdit';

let DIR: string;

beforeEach(async () => {
  DIR = await fs.mkdtemp(join(tmpdir(), 'oru-test-applytextedit-'));
});

afterEach(async () => {
  await fs.rm(DIR, { recursive: true, force: true });
});

async function writeFixture(name: string, content: string): Promise<string> {
  const p = join(DIR, name);
  await fs.writeFile(p, content, 'utf-8');
  return p;
}

const read = (p: string) => fs.readFile(p, 'utf-8');

describe('applyTextEdit', () => {
  it('唯一文本 → ok，文件已替换', async () => {
    const p = await writeFixture('a.html', '<p>hello world</p>');
    const r = await applyTextEdit({ filePath: p, oldText: 'hello world', newText: 'bye' });
    expect(r).toEqual({ ok: true });
    expect(await read(p)).toBe('<p>bye</p>');
  });

  it('重复文本 → ambiguous，文件未变', async () => {
    const html = '<p>dup</p><span>dup</span>';
    const p = await writeFixture('b.html', html);
    const r = await applyTextEdit({ filePath: p, oldText: 'dup', newText: 'x' });
    expect(r).toEqual({ ok: false, reason: 'ambiguous' });
    expect(await read(p)).toBe(html);
  });

  it('不存在文本 → not-found，文件未变', async () => {
    const html = '<p>hello</p>';
    const p = await writeFixture('c.html', html);
    const r = await applyTextEdit({ filePath: p, oldText: 'nope', newText: 'x' });
    expect(r).toEqual({ ok: false, reason: 'not-found' });
    expect(await read(p)).toBe(html);
  });

  it('data-edit-id 快路径 → 避开同文本歧义，只改带 marker 的元素', async () => {
    // 同一段文字出现两次，但目标元素带 data-edit-id —— 慢路径会判 ambiguous，快路径精准命中
    const html = '<p>同样文字</p><p data-edit-id="m1">同样文字</p>';
    const p = await writeFixture('d.html', html);
    const r = await applyTextEdit({
      filePath: p,
      markerId: 'm1',
      oldText: '同样文字',
      newText: '改了',
    });
    expect(r).toEqual({ ok: true });
    expect(await read(p)).toBe('<p>同样文字</p><p data-edit-id="m1">改了</p>');
  });

  it('marker 不存在但 oldText 全文唯一 → 落慢路径，改的是 oldText 那处', async () => {
    // marker 是定位提示，缺失不代表 oldText 唯一性会错——落慢路径仍由唯一性守住「绝不改错」
    const html = '<p data-edit-id="m1">keep</p><span>target</span>';
    const p = await writeFixture('e.html', html);
    const r = await applyTextEdit({
      filePath: p,
      markerId: 'absent',
      oldText: 'target',
      newText: 'changed',
    });
    expect(r).toEqual({ ok: true });
    expect(await read(p)).toBe('<p data-edit-id="m1">keep</p><span>changed</span>');
  });

  it('marker 不存在且 oldText 重复 → ambiguous，文件未变', async () => {
    const html = '<p data-edit-id="m1">dup</p><span>dup</span>';
    const p = await writeFixture('e2.html', html);
    const r = await applyTextEdit({
      filePath: p,
      markerId: 'absent',
      oldText: 'dup',
      newText: 'x',
    });
    expect(r).toEqual({ ok: false, reason: 'ambiguous' });
    expect(await read(p)).toBe(html);
  });

  it('newText 含 $&/$1 → 字面写入，不被当替换模式', async () => {
    const p = await writeFixture('f.html', '<p>price</p>');
    const r = await applyTextEdit({ filePath: p, oldText: 'price', newText: '$& and $1 = $100' });
    expect(r).toEqual({ ok: true });
    expect(await read(p)).toBe('<p>$& and $1 = $100</p>');
  });

  it('快路径 newText 含 $&/$1 → 字面写入', async () => {
    const p = await writeFixture('f2.html', '<p data-edit-id="m1">orig</p>');
    const r = await applyTextEdit({
      filePath: p,
      markerId: 'm1',
      oldText: 'orig',
      newText: '$1$&literal',
    });
    expect(r).toEqual({ ok: true });
    expect(await read(p)).toBe('<p data-edit-id="m1">$1$&literal</p>');
  });

  it('过期 expectedMtimeMs → conflict，文件未变', async () => {
    const html = '<p>hello</p>';
    const p = await writeFixture('g.html', html);
    const stat = await fs.stat(p);
    const stale = Math.floor(stat.mtimeMs) - 5000; // 比真实 mtime 小 → 视为基线过期
    const r = await applyTextEdit({
      filePath: p,
      oldText: 'hello',
      newText: 'x',
      expectedMtimeMs: stale,
    });
    expect(r).toEqual({ ok: false, reason: 'conflict' });
    expect(await read(p)).toBe(html);
  });

  it('expectedMtimeMs 与磁盘一致 → 正常写入', async () => {
    const p = await writeFixture('g2.html', '<p>hello</p>');
    const stat = await fs.stat(p);
    const r = await applyTextEdit({
      filePath: p,
      oldText: 'hello',
      newText: 'ok',
      expectedMtimeMs: Math.floor(stat.mtimeMs),
    });
    expect(r).toEqual({ ok: true });
    expect(await read(p)).toBe('<p>ok</p>');
  });

  it('文件不存在 → io', async () => {
    const r = await applyTextEdit({
      filePath: join(DIR, 'nope.html'),
      oldText: 'x',
      newText: 'y',
    });
    expect(r).toEqual({ ok: false, reason: 'io' });
  });

  it('returnHtml → 成功带写盘前后全文（before/after 与磁盘一致）', async () => {
    const before = '<p>hello world</p>';
    const p = await writeFixture('r.html', before);
    const r = await applyTextEdit({
      filePath: p,
      oldText: 'hello world',
      newText: 'bye',
      returnHtml: true,
    });
    expect(r).toEqual({ ok: true, before, after: '<p>bye</p>' });
    // after 必须是真实落盘内容（供调用方做 undo 快照）
    expect(await read(p)).toBe((r as { after: string }).after);
  });

  it('不传 returnHtml → 成功仍是裸 { ok:true }（不带 html，向后兼容）', async () => {
    const p = await writeFixture('r2.html', '<p>x</p>');
    const r = await applyTextEdit({ filePath: p, oldText: 'x', newText: 'y' });
    expect(r).toEqual({ ok: true });
  });

  it('returnHtml 但定位失败 → 仍是纯拒绝结果（不带 html）', async () => {
    const p = await writeFixture('r3.html', '<p>dup</p><p>dup</p>');
    const r = await applyTextEdit({
      filePath: p,
      oldText: 'dup',
      newText: 'x',
      returnHtml: true,
    });
    expect(r).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('同文件并发两次合法编辑（不同 oldText）→ 串行、都落、无丢更新', async () => {
    const p = await writeFixture('h.html', '<p>aaa</p><p>bbb</p>');
    const [r1, r2] = await Promise.all([
      applyTextEdit({ filePath: p, oldText: 'aaa', newText: 'AAA' }),
      applyTextEdit({ filePath: p, oldText: 'bbb', newText: 'BBB' }),
    ]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(await read(p)).toBe('<p>AAA</p><p>BBB</p>');
  });

  it('同文件【不同路径写法】并发 → 仍串行、无丢更新（锁 key 归一回归）', async () => {
    // 回归 2026-06-17 bug：runExclusive 的 key 未 resolve 归一时，'/dir/./h3.html' 与
    // '/dir/h3.html' 会落两把不同的锁 → 两个 op 并发读到同一旧内容 → 后写覆盖前写、丢一处更新。
    // 归一后两者落同一把锁、串行执行，两处都应落盘。
    const name = 'h3.html';
    const p = await writeFixture(name, '<p>aaa</p><p>bbb</p>');
    const pDenormalized = `${DIR}/./${name}`; // 同一文件，未归一的路径字符串
    const [r1, r2] = await Promise.all([
      applyTextEdit({ filePath: p, oldText: 'aaa', newText: 'AAA' }),
      applyTextEdit({ filePath: pDenormalized, oldText: 'bbb', newText: 'BBB' }),
    ]);
    expect(r1).toEqual({ ok: true });
    expect(r2).toEqual({ ok: true });
    expect(await read(p)).toBe('<p>AAA</p><p>BBB</p>');
  });
});
