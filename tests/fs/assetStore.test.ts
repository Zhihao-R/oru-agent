import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { uniqueLeaf, writeImageToAssets } from '../../electron/main/fs/assetStore';

/**
 * uniqueLeaf —— 纯候选名生成（§八）。撞名靠 §7.2 的 wx 重试裁决，这里只负责
 * 把「基名 + 序号 + 扩展名」拼成候选，格式对齐 duplicateEntry 的「空格 + 序号」。
 */
describe('uniqueLeaf', () => {
  it('首个候选（n=1）不带序号后缀', () => {
    expect(uniqueLeaf('图', '.png', 1)).toBe('图.png');
  });

  it('n≥2 在基名与扩展名之间插「空格序号」', () => {
    expect(uniqueLeaf('图', '.png', 2)).toBe('图 2.png');
    expect(uniqueLeaf('图', '.png', 3)).toBe('图 3.png');
  });

  it('扩展名原样拼接（含点，由 extname 直接喂入）', () => {
    expect(uniqueLeaf('shot', '.jpeg', 1)).toBe('shot.jpeg');
    expect(uniqueLeaf('shot', '.jpeg', 2)).toBe('shot 2.jpeg');
  });

  it('分隔符可覆盖（默认空格）', () => {
    expect(uniqueLeaf('a', '.png', 2, '-')).toBe('a-2.png');
  });
});

/**
 * writeImageToAssets —— 字节落盘到 `<文档名>.assets/`（§七）。
 * 不走 safeWrite，用 writeFile(flag:'wx') 原子创建挡并发同名覆盖。
 */
describe('writeImageToAssets', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'oru-assets-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('落地一张图：建 <文档名>.assets/、写入字节、返回相对引用', async () => {
    const doc = join(root, '方案.md');
    writeFileSync(doc, '# 方案');
    const bytes = Buffer.from([1, 2, 3, 4]);

    const ref = await writeImageToAssets(doc, bytes, '图', '.png');

    expect(ref).toBe('方案.assets/图.png');
    const abs = join(root, ref);
    expect(existsSync(abs)).toBe(true);
    expect(readFileSync(abs)).toEqual(bytes);
  });

  it('撞名加序号：老文件分毫不动，新图落到「图 2.png」', async () => {
    const doc = join(root, '方案.md');
    writeFileSync(doc, '# 方案');
    const first = Buffer.from([1]);
    const second = Buffer.from([2]);

    const ref1 = await writeImageToAssets(doc, first, '图', '.png');
    const ref2 = await writeImageToAssets(doc, second, '图', '.png');

    expect(ref1).toBe('方案.assets/图.png');
    expect(ref2).toBe('方案.assets/图 2.png');
    expect(readFileSync(join(root, ref1))).toEqual(first); // 老文件不动
    expect(readFileSync(join(root, ref2))).toEqual(second);
  });

  it('并发：两图几乎同时同名落地，得到两个不同文件、互不覆盖（wx 撞名重试）', async () => {
    const doc = join(root, '方案.md');
    writeFileSync(doc, '# 方案');
    const a = Buffer.from([0xaa]);
    const b = Buffer.from([0xbb]);

    const [ra, rb] = await Promise.all([
      writeImageToAssets(doc, a, '图', '.png'),
      writeImageToAssets(doc, b, '图', '.png'),
    ]);

    expect(ra).not.toBe(rb); // 两个不同文件名
    const dir = join(root, '方案.assets');
    expect(readdirSync(dir).sort()).toEqual(['图 2.png', '图.png']);
    // 两份字节都在盘上、互不覆盖
    const bytes = readdirSync(dir).map((f) => readFileSync(join(dir, f))[0]).sort();
    expect(bytes).toEqual([0xaa, 0xbb]);
  });

  it('attacker：ext 含 /../ 逃逸构造 → 拒绝落盘（后端守门，绝不写出 assets 外）', async () => {
    const doc = join(root, '方案.md');
    writeFileSync(doc, '# 方案');

    await expect(writeImageToAssets(doc, Buffer.from([1]), 'x', '/../../evil.sh')).rejects.toThrow();
    await expect(writeImageToAssets(doc, Buffer.from([1]), 'x', '.svg')).rejects.toThrow(); // 非白名单

    // 项目外 / 上级目录均无被写出文件
    expect(existsSync(join(root, '..', 'evil.sh'))).toBe(false);
    expect(existsSync(join(root, 'evil.sh'))).toBe(false);
  });

  it('ext 大小写归一（.PNG → .png）', async () => {
    const doc = join(root, '方案.md');
    writeFileSync(doc, '# 方案');
    const ref = await writeImageToAssets(doc, Buffer.from([1]), '图', '.PNG');
    expect(ref).toBe('方案.assets/图.png');
  });

  it('attacker：preferredBase 含路径分隔符/.. 被消解成安全 leaf，不逃出 assets', async () => {
    const doc = join(root, '方案.md');
    writeFileSync(doc, '# 方案');

    const ref = await writeImageToAssets(doc, Buffer.from([9]), '../../evil', '.png');

    // 落点必须仍在 方案.assets/ 内，单层文件名
    expect(ref.startsWith('方案.assets/')).toBe(true);
    expect(ref).not.toContain('..');
    expect(ref.slice('方案.assets/'.length)).not.toContain('/');
    expect(existsSync(join(root, ref))).toBe(true);
    // 项目外没有被写出文件
    expect(existsSync(join(root, '..', 'evil.png'))).toBe(false);
  });
});
