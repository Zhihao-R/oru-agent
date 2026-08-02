/**
 * grepSearch 底层单测——重点覆盖两类易被静默吞掉的边界：
 *   - 扫描文件数超上限（scan_cap）：必须区别于 head_limit 截断
 *   - 单行大 HTML（超长行）：必须照常命中，content 模式只回片段而非整行
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grepSearch } from '../../electron/main/fs/search';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'grep-test-'));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('grepSearch 截断原因区分', () => {
  it('命中数超 headLimit → truncated=head_limit', async () => {
    const dir = join(root, 'many-hits');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `f${i}.txt`), 'needle', 'utf-8');
    const r = await grepSearch({ pattern: 'needle', root: dir, outputMode: 'files_with_matches', headLimit: 3 });
    expect(r.truncated).toBe('head_limit');
  });

  it('扫描文件数超 maxFilesScanned → truncated=scan_cap（即便没几个命中）', async () => {
    const dir = join(root, 'many-files');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `f${i}.txt`), 'irrelevant', 'utf-8');
    // 注入极小扫描上限，模拟"大目录扫不完"
    const r = await grepSearch({ pattern: 'zzz-no-match', root: dir, outputMode: 'files_with_matches', headLimit: 250, maxFilesScanned: 3 });
    expect(r.truncated).toBe('scan_cap');
  });

  it('正常搜完不截断 → truncated=false', async () => {
    const dir = join(root, 'small');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'a.txt'), 'hello world', 'utf-8');
    const r = await grepSearch({ pattern: 'hello', root: dir, outputMode: 'files_with_matches', headLimit: 250 });
    expect(r.truncated).toBe(false);
  });
});

describe('grepSearch 超长行（单行大 HTML）', () => {
  it('单行超长文件照常命中 files_with_matches', async () => {
    const dir = join(root, 'big-html');
    mkdirSync(dir, { recursive: true });
    // 整份文件就一行，目标词埋在 5 万字符中间
    const oneLine = 'x'.repeat(50000) + '报销流程' + 'y'.repeat(50000);
    writeFileSync(join(dir, 'page.html'), oneLine, 'utf-8');
    const r = await grepSearch({ pattern: '报销流程', root: dir, outputMode: 'files_with_matches', headLimit: 250 });
    expect(r.mode).toBe('files_with_matches');
    if (r.mode === 'files_with_matches') expect(r.files).toContain('page.html');
  });

  it('content 模式只回命中片段，不吐整行', async () => {
    const dir = join(root, 'big-html-content');
    mkdirSync(dir, { recursive: true });
    const oneLine = 'x'.repeat(50000) + '报销流程' + 'y'.repeat(50000);
    writeFileSync(join(dir, 'page.html'), oneLine, 'utf-8');
    const r = await grepSearch({ pattern: '报销流程', root: dir, outputMode: 'content', headLimit: 250 });
    expect(r.mode).toBe('content');
    if (r.mode === 'content') {
      expect(r.matches).toHaveLength(1);
      const text = r.matches[0]!.text;
      expect(text).toContain('报销流程'); // 命中词在
      expect(text.length).toBeLessThan(1000); // 片段而非 10 万字符整行
      expect(text.startsWith('…') && text.endsWith('…')).toBe(true); // 两端有省略标记
    }
  });

  it('长跨度匹配在超长行里不被片段切断（命中区间两端都保留）', async () => {
    const dir = join(root, 'big-html-longmatch');
    mkdirSync(dir, { recursive: true });
    // 命中跨度 ~504 字符，远超 CLIP_RADIUS(200)；若以命中起点而非区间右端算 end，'流程' 会被切掉
    const oneLine = 'x'.repeat(50000) + '报销' + 'z'.repeat(500) + '流程' + 'y'.repeat(50000);
    writeFileSync(join(dir, 'page.html'), oneLine, 'utf-8');
    const r = await grepSearch({ pattern: '报销z+流程', root: dir, outputMode: 'content', headLimit: 250 });
    expect(r.mode).toBe('content');
    if (r.mode === 'content') {
      const text = r.matches[0]!.text;
      expect(text).toContain('报销'); // 命中区间左端
      expect(text).toContain('流程'); // 命中区间右端，旧实现会丢
    }
  });

  it('单行多命中：一行内 N 处命中各回一条（deck 被压成一行的核心场景）', async () => {
    const dir = join(root, 'big-html-multi');
    mkdirSync(dir, { recursive: true });
    // 模拟导出的单行 deck：5 个 slide 标记挤在同一行，每个间隔 1000 字符
    const filler = 'x'.repeat(1000);
    const oneLine =
      Array.from({ length: 5 }, (_, i) => `<section class="slide"><h2>第${i}页</h2>`).join(filler) + filler;
    writeFileSync(join(dir, 'deck.html'), oneLine, 'utf-8');
    const r = await grepSearch({ pattern: 'class="slide"', root: dir, outputMode: 'content', headLimit: 250 });
    expect(r.mode).toBe('content');
    if (r.mode === 'content') {
      expect(r.matches).toHaveLength(5); // 5 处全回，而非只回首个
      expect(r.matches.every((m) => m.line === 1)).toBe(true); // 同一行，行号都是 1
      expect(r.matches[0]!.text).toContain('第0页'); // 片段带得出紧随命中的标题，agent 才能"看到每页讲什么"
    }
  });

  it('单行多命中：count 模式数命中数而非命中行数', async () => {
    const dir = join(root, 'big-html-count');
    mkdirSync(dir, { recursive: true });
    const filler = 'x'.repeat(1000);
    const oneLine = Array.from({ length: 5 }, () => 'class="slide"').join(filler);
    writeFileSync(join(dir, 'deck.html'), oneLine, 'utf-8');
    const r = await grepSearch({ pattern: 'class="slide"', root: dir, outputMode: 'count', headLimit: 250 });
    if (r.mode === 'count') {
      expect(r.counts[0]!.count).toBe(5); // 数到 5 个命中，不是"1 个命中行"
    }
  });

  it('零宽匹配不卡死、不在超长行上爆量', async () => {
    const dir = join(root, 'zero-width');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'page.html'), 'x'.repeat(50000) + '报销' + 'x'.repeat(50000), 'utf-8');
    // x* 在每个空位都能零宽匹配——必须靠 lastIndex 推进护栏，否则死循环 / 命中数爆炸
    const r = await grepSearch({ pattern: 'x*', root: dir, outputMode: 'count', headLimit: 250 });
    if (r.mode === 'count') {
      expect(r.counts[0]!.count).toBeLessThan(10); // 贪婪吞掉连续 x，只剩极少非空命中
    }
  });

  it('content + context：命中行截片段，上下文行原样拼接', async () => {
    const dir = join(root, 'ctx');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'doc.md'), '上一行\n这里有报销流程\n下一行', 'utf-8');
    const r = await grepSearch({ pattern: '报销流程', root: dir, outputMode: 'content', context: 1, headLimit: 250 });
    if (r.mode === 'content') {
      const text = r.matches[0]!.text;
      expect(text).toContain('上一行');
      expect(text).toContain('报销流程');
      expect(text).toContain('下一行');
    }
  });
});
