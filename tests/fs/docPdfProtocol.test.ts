import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseDocPdfUrl, resolveDocPdfRequest } from '../../electron/main/fs/docPdfProtocol';

/**
 * docPdfProtocol —— oru-doc-pdf:// 的 URL 两段解析 + 一道沙箱校验纯函数（tech design §二）。
 * URL 自带「文档身份（projectId + 项目相对 pdf path）」，主进程不信 URL 里的 path：
 *   一道 ensureWithinProject 校验在项目内（拦 `../` 逃逸）+ realpath 抹平 symlink，扩展名只 .pdf。
 * 比 docImage 少第二段落点校验（PDF 是文件本身、无 assets 目录概念）。保证不 throw。
 */

describe('parseDocPdfUrl', () => {
  it('正常：两段是 projectId + 项目相对 pdf path（各整段 encode）', () => {
    const url =
      'oru-doc-pdf://local/' +
      [encodeURIComponent('proj-1'), encodeURIComponent('子目录/报告 2.pdf')].join('/');
    expect(parseDocPdfUrl(url)).toEqual({ projectId: 'proj-1', pdfPath: '子目录/报告 2.pdf' });
  });

  it('段数不足（缺 pdfPath）→ null', () => {
    expect(parseDocPdfUrl('oru-doc-pdf://local/' + encodeURIComponent('p'))).toBeNull();
  });

  it('段数过多（多余段）→ null（PDF 只该有两段，畸形即拒）', () => {
    const url = 'oru-doc-pdf://local/' + ['p', 'a.pdf', 'extra'].map(encodeURIComponent).join('/');
    expect(parseDocPdfUrl(url)).toBeNull();
  });

  it('畸形 URL（坏的 % 序列）→ null，不抛', () => {
    expect(parseDocPdfUrl('oru-doc-pdf://local/%E0%A4%A/a.pdf')).toBeNull();
  });
});

describe('resolveDocPdfRequest', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'oru-docpdf-'));
  });
  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('合法：项目内 .pdf → 命中，返回 realpath', async () => {
    writeFileSync(join(projectRoot, '报告.pdf'), Buffer.from([1]));
    const r = await resolveDocPdfRequest(projectRoot, '报告.pdf');
    expect(r).not.toBeNull();
    expect(r!.filePath.endsWith('报告.pdf')).toBe(true);
  });

  it('子目录里带空格的文件名能命中', async () => {
    mkdirSync(join(projectRoot, '子目录'), { recursive: true });
    writeFileSync(join(projectRoot, '子目录', '季度 报告.pdf'), Buffer.from([1]));
    expect(await resolveDocPdfRequest(projectRoot, '子目录/季度 报告.pdf')).not.toBeNull();
  });

  it('attacker：pdfPath 含 ../ 逃出项目 → null', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oru-outside-'));
    try {
      writeFileSync(join(outside, 'secret.pdf'), Buffer.from([1]));
      expect(await resolveDocPdfRequest(projectRoot, '../../oru-outside/secret.pdf')).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('attacker：绝对路径 → null', async () => {
    expect(await resolveDocPdfRequest(projectRoot, '/etc/hosts')).toBeNull();
  });

  it('attacker：symlink 指向项目外的 pdf → null', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'oru-outside-'));
    try {
      const target = join(outside, 'secret.pdf');
      writeFileSync(target, Buffer.from([1]));
      symlinkSync(target, join(projectRoot, 'link.pdf'));
      expect(await resolveDocPdfRequest(projectRoot, 'link.pdf')).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('非 pdf 扩展名（.txt / .pdf.exe）→ null', async () => {
    writeFileSync(join(projectRoot, 'x.txt'), 'hi');
    expect(await resolveDocPdfRequest(projectRoot, 'x.txt')).toBeNull();
  });

  it('文件不存在 → null（不抛）', async () => {
    expect(await resolveDocPdfRequest(projectRoot, 'ghost.pdf')).toBeNull();
  });
});
