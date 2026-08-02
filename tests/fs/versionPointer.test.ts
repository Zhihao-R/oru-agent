/**
 * html 薄版本指针（项目B 第三期 Task11）。
 *
 * html 不背 deck 的 manifest/currentVersion/changedPages/undo——指针只需 commit/checkout/restore，
 * 直连 fileHistory。versionId = fileHistory snapshot id（sNNN）。commit 内容未变复用现存 ref
 * （before 永不落空）。checkout 把内容写回 htmlPath（safeWrite）。
 *
 * ORU_DIR 在 import 前重定向（fileHistory 落 ~/.oru/users/<owner>/history/）。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-htmlptr-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const HTML_A = '<!doctype html><html><body><h1>A</h1></body></html>';
const HTML_B = '<!doctype html><html><body><h1>B</h1></body></html>';

let dir = '';
beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  dir = join(ORU_DIR, 'docs');
  await fs.mkdir(dir, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('htmlVersionPointer：直连 fileHistory，无 manifest', () => {
  it('commit 落 fileHistory 快照、返回 snapshot id', async () => {
    const { htmlVersionPointer } = await import('../../electron/main/fs/versionPointer');
    const FH = await import('../../electron/main/fs/fileHistory');
    const htmlPath = join(dir, 'commit.html');
    await fs.writeFile(htmlPath, HTML_A);

    const ptr = htmlVersionPointer(htmlPath);
    const { versionId } = await ptr.commit('protective', '提交前');
    expect(versionId).toMatch(/^s\d+$/); // versionId = fileHistory snapshot id
    expect(await FH.restore(resolve(htmlPath), versionId)).toBe(HTML_A);
  });

  it('内容未变再 commit → 复用同一 id（before 不落空）', async () => {
    const { htmlVersionPointer } = await import('../../electron/main/fs/versionPointer');
    const htmlPath = join(dir, 'dedup.html');
    await fs.writeFile(htmlPath, HTML_A);
    const ptr = htmlVersionPointer(htmlPath);

    const first = await ptr.commit('protective', 'before');
    const again = await ptr.commit('ai', 'after-but-unchanged');
    expect(again.versionId).toBe(first.versionId); // 复用，不返 null、不落空
  });

  it('checkout(id) 写回 htmlPath；restore(id) 取内容', async () => {
    const { htmlVersionPointer } = await import('../../electron/main/fs/versionPointer');
    const htmlPath = join(dir, 'checkout.html');
    await fs.writeFile(htmlPath, HTML_A);
    const ptr = htmlVersionPointer(htmlPath);

    const before = await ptr.commit('protective', '改前'); // 快照 HTML_A
    await fs.writeFile(htmlPath, HTML_B); // 模拟 AI 改成 HTML_B
    const after = await ptr.commit('ai', '改后'); // 快照 HTML_B
    expect(after.versionId).not.toBe(before.versionId);

    await ptr.checkout(before.versionId); // 退回改前
    expect(await fs.readFile(htmlPath, 'utf-8')).toBe(HTML_A);
    expect(await ptr.restore(after.versionId)).toBe(HTML_B); // restore 不改盘，仅取内容
    expect(await ptr.restore(before.versionId)).toBe(HTML_A);
  });
});
