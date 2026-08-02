import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocImageUrl, resolveDocImageRequest } from '../../electron/main/fs/docImageProtocol';

/**
 * docImageProtocol —— oru-doc-img:// 的 URL 三段解析 + 两道沙箱校验纯函数（§二 / §4.1）。
 * URL 自带「文档身份（projectId + 项目相对文档 path）+ 图相对文档的引用」，主进程不再靠全局 activeDoc：
 *   ① 文档身份一道：docPath 经 ensureWithinProject 校验在项目内（拦 `../` 逃逸）。
 *   ② 图片落点一道：imageRef 相对 docDir 解析后再校验，且 realpath 后必须直属该文档自己的 `<文档名>.assets/`、
 *      单层、图片扩展名；否则 null（保证不 throw，渲染端可手搓恶意 URL）。
 */

describe('parseDocImageUrl', () => {
  it('正常：前两段是文档身份，其后拼回图引用（各段独立 encode 无歧义）', () => {
    const url =
      'oru-doc-img://local/' +
      [encodeURIComponent('proj-1'), encodeURIComponent('子目录/方案.md')].join('/') +
      '/' +
      ['方案.assets', '图 2.png'].map(encodeURIComponent).join('/');
    expect(parseDocImageUrl(url)).toEqual({
      projectId: 'proj-1',
      docPath: '子目录/方案.md',
      imageRef: '方案.assets/图 2.png',
    });
  });

  it('段数不足（缺 imageRef）→ null', () => {
    const url = 'oru-doc-img://local/' + ['p', 'a.md'].map(encodeURIComponent).join('/');
    expect(parseDocImageUrl(url)).toBeNull();
  });

  it('畸形 URL（坏的 % 序列）→ null，不抛', () => {
    expect(parseDocImageUrl('oru-doc-img://local/%E0%A4%A/a.md/x.png')).toBeNull();
  });
});

describe('resolveDocImageRequest', () => {
  let projectRoot: string; // 项目根
  const docPath = '子目录/方案.md'; // 项目相对文档 path
  const docName = '方案';
  let assetsDir: string; // <projectRoot>/子目录/方案.assets

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'oru-docimg-'));
    assetsDir = join(projectRoot, '子目录', `${docName}.assets`);
    mkdirSync(assetsDir, { recursive: true });
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  // imageRef 相对文档目录（与渲染端 docImageUrl 编码口径一致：文档内相对引用）。
  const refFor = (file: string): string => `${docName}.assets/${file}`;

  it('合法：该文档自己的 assets 下的图片 → 命中，返回 realpath + mime', async () => {
    writeFileSync(join(assetsDir, '图.png'), Buffer.from([1]));
    const r = await resolveDocImageRequest(projectRoot, docPath, refFor('图.png'));
    expect(r).not.toBeNull();
    expect(r!.mime).toBe('image/png');
    expect(r!.filePath.endsWith(`${docName}.assets/图.png`)).toBe(true);
  });

  it('带空格的文件名（图 2.png）能命中', async () => {
    writeFileSync(join(assetsDir, '图 2.png'), Buffer.from([1]));
    expect(await resolveDocImageRequest(projectRoot, docPath, refFor('图 2.png'))).not.toBeNull();
  });

  it('jpg/jpeg/gif/webp 各自映射 mime', async () => {
    for (const [ext, mime] of [
      ['.jpg', 'image/jpeg'],
      ['.jpeg', 'image/jpeg'],
      ['.gif', 'image/gif'],
      ['.webp', 'image/webp'],
    ] as const) {
      writeFileSync(join(assetsDir, `x${ext}`), Buffer.from([1]));
      const r = await resolveDocImageRequest(projectRoot, docPath, refFor(`x${ext}`));
      expect(r?.mime).toBe(mime);
    }
  });

  it('回归：两个不同文档的 URL 各解析到各自 assets，不串 docDir（§4.1）', async () => {
    // 文档 A：子目录/方案.md → 子目录/方案.assets
    writeFileSync(join(assetsDir, 'a.png'), Buffer.from([1]));
    // 文档 B：另一篇.md（项目根）→ 另一篇.assets
    const bAssets = join(projectRoot, '另一篇.assets');
    mkdirSync(bAssets, { recursive: true });
    writeFileSync(join(bAssets, 'b.png'), Buffer.from([2]));

    const ra = await resolveDocImageRequest(projectRoot, '子目录/方案.md', '方案.assets/a.png');
    const rb = await resolveDocImageRequest(projectRoot, '另一篇.md', '另一篇.assets/b.png');

    expect(ra!.filePath.endsWith('子目录/方案.assets/a.png')).toBe(true);
    expect(rb!.filePath.endsWith('另一篇.assets/b.png')).toBe(true);
    // A 的引用配 B 的文档身份 → A 的图不在 B 的 assets 下 → null（不串）
    expect(await resolveDocImageRequest(projectRoot, '另一篇.md', '方案.assets/a.png')).toBeNull();
  });

  it('attacker：docPath 含 ../ 逃出项目 → 文档身份沙箱挡掉，null', async () => {
    // 即使逃逸目标真实存在 .assets/图，docPath 沙箱也先拒
    const outside = mkdtempSync(join(tmpdir(), 'oru-outside-'));
    try {
      mkdirSync(join(outside, '方案.assets'), { recursive: true });
      writeFileSync(join(outside, '方案.assets', 'x.png'), Buffer.from([1]));
      expect(
        await resolveDocImageRequest(projectRoot, '../../oru-outside/方案.md', '方案.assets/x.png'),
      ).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('attacker：imageRef 含 ../ 逃出 assets → 图片落点沙箱挡掉，null', async () => {
    // 项目内别处放一张图，imageRef 用 ../ 想引它——不在本文档 assets 下，挡掉
    writeFileSync(join(projectRoot, '子目录', 'sibling.png'), Buffer.from([1]));
    expect(
      await resolveDocImageRequest(projectRoot, docPath, '方案.assets/../sibling.png'),
    ).toBeNull();
  });

  it('attacker：imageRef 含 ../../ 逃出项目 → null', async () => {
    expect(
      await resolveDocImageRequest(projectRoot, docPath, '../../../../etc/passwd'),
    ).toBeNull();
  });

  it('attacker：同目录里的 evil.assets/（非本文档名）→ null', async () => {
    const evil = join(projectRoot, '子目录', 'evil.assets');
    mkdirSync(evil, { recursive: true });
    writeFileSync(join(evil, 'secret.png'), Buffer.from([1]));
    expect(await resolveDocImageRequest(projectRoot, docPath, 'evil.assets/secret.png')).toBeNull();
  });

  it('attacker：嵌套 a.assets/b.assets/ → null', async () => {
    const nested = join(assetsDir, 'b.assets');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'c.png'), Buffer.from([1]));
    expect(
      await resolveDocImageRequest(projectRoot, docPath, '方案.assets/b.assets/c.png'),
    ).toBeNull();
  });

  it('attacker：assets 后再嵌子目录（x.assets/sub/y.png）→ null', async () => {
    const sub = join(assetsDir, 'sub');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'y.png'), Buffer.from([1]));
    expect(await resolveDocImageRequest(projectRoot, docPath, '方案.assets/sub/y.png')).toBeNull();
  });

  it('attacker：assets 内 symlink 指向项目外 → null', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oru-outside-'));
    try {
      const target = join(outside, 'secret.png');
      writeFileSync(target, Buffer.from([1]));
      symlinkSync(target, join(assetsDir, 'link.png'));
      expect(
        await resolveDocImageRequest(projectRoot, docPath, '方案.assets/link.png'),
      ).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('非图扩展名（.svg / .txt）→ null', async () => {
    writeFileSync(join(assetsDir, 'x.svg'), '<svg/>');
    expect(await resolveDocImageRequest(projectRoot, docPath, '方案.assets/x.svg')).toBeNull();
  });
});
