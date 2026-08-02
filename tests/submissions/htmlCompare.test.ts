/**
 * html 改前/改后对比落点泛化（项目B 第三期 Task13）。
 *
 * 对比把两版完整内容临时写到**活动文件所在目录**（相对资源 images/ 才解析得对），html 文件名带
 * `.{base}.compare-*` 前缀——同目录多个松散 html 互不撞（同 Task10 sidecar 动机）。deck 落点/文件名不变。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-htmlcompare-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const HTML_A = '<!doctype html><html><body><h1>改前</h1></body></html>';
const HTML_B = '<!doctype html><html><body><h1>改后</h1></body></html>';

let dir = '';
beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
  dir = join(ORU_DIR, 'docs');
  await fs.mkdir(dir, { recursive: true });
});
afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

/** 用 html 指针落两版，返回 before/after id。 */
async function twoVersions(htmlPath: string): Promise<{ before: string; after: string }> {
  const { htmlVersionPointer } = await import('../../electron/main/fs/versionPointer');
  const ptr = htmlVersionPointer(htmlPath);
  await fs.writeFile(htmlPath, HTML_A);
  const before = (await ptr.commit('protective', '')).versionId;
  await fs.writeFile(htmlPath, HTML_B);
  const after = (await ptr.commit('ai', '')).versionId;
  return { before, after };
}

describe('html 对比落点 = 活动文件目录，文件名带前缀防撞', () => {
  it('prepareCompareFor：临时文件落 html 同目录、内容 === 两快照、名带 .{base} 前缀', async () => {
    const htmlPath = join(dir, 'report.html');
    const { before, after } = await twoVersions(htmlPath);
    const { htmlTarget } = await import('../../electron/main/submissions/target');
    const { prepareCompareFor, cleanupCompareFor } = await import('../../electron/main/deck/compare');

    const { beforeFile, afterFile } = await prepareCompareFor(htmlTarget(htmlPath), before, after);
    expect(beforeFile).toBe('.report.html.compare-before.html'); // 带 .{base} 前缀
    expect(afterFile).toBe('.report.html.compare-after.html');
    // 落在 html 同目录、内容对
    expect(await fs.readFile(join(dir, beforeFile), 'utf-8')).toBe(HTML_A);
    expect(await fs.readFile(join(dir, afterFile), 'utf-8')).toBe(HTML_B);

    await cleanupCompareFor(htmlTarget(htmlPath));
    await expect(fs.access(join(dir, beforeFile))).rejects.toThrow();
  });

  it('同目录两个 html 对比文件名互不撞', async () => {
    const { htmlTarget } = await import('../../electron/main/submissions/target');
    const fooT = htmlTarget(join(dir, 'foo.html'));
    const barT = htmlTarget(join(dir, 'bar.html'));
    expect(basename(fooT.compareTmp.before)).toBe('.foo.html.compare-before.html');
    expect(basename(barT.compareTmp.before)).toBe('.bar.html.compare-before.html');
  });
});
