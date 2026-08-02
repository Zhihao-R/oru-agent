import { describe, expect, it } from 'vitest';
import { docImageUrl, ImageWidget } from '../../src/components/editor/livePreview';

const ID = { projectId: 'proj-1', docPath: '子目录/方案.md' };

/**
 * docImageUrl —— 把文档内相对引用 + 文档身份编成 oru-doc-img:// URL（§4.1 去全局 activeDoc）：
 * 前两段是文档身份（projectId + 项目相对 path），其后是图引用。关键性质：能被主进程稳定拆出三段、
 * 各段独立编码无分隔歧义、含空格/中文往返一致。无文档身份 → 空字符串（<img> 走缺失占位）。
 */
describe('docImageUrl', () => {
  // 与主进程 parseDocImageUrl 等价的本地拆段（验证 URL 可被稳定三段解析）
  const parse = (url: string): { projectId: string; docPath: string; imageRef: string } => {
    const segs = new URL(url).pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent);
    const [projectId, docPath, ...rest] = segs;
    return { projectId, docPath, imageRef: rest.join('/') };
  };

  it('scheme + local 占位 host', () => {
    expect(docImageUrl('架构.assets/x.png', ID)).toMatch(/^oru-doc-img:\/\/local\//);
  });

  it('无文档身份 → 空字符串', () => {
    expect(docImageUrl('a.assets/x.png', null)).toBe('');
  });

  it('三段往返一致：拆出的 projectId / docPath / imageRef 各还原（含空格/中文）', () => {
    for (const rel of ['架构.assets/图 2.png', 'a.assets/b.png']) {
      const parsed = parse(docImageUrl(rel, ID));
      expect(parsed.projectId).toBe(ID.projectId);
      expect(parsed.docPath).toBe(ID.docPath);
      expect(parsed.imageRef).toBe(rel);
    }
  });

  it('docPath 含 / 不与图引用分隔混淆（整段编码）', () => {
    const parsed = parse(docImageUrl('架构.assets/c.png', { projectId: 'p', docPath: 'a/b/c.md' }));
    expect(parsed.docPath).toBe('a/b/c.md');
    expect(parsed.imageRef).toBe('架构.assets/c.png');
  });
});

/**
 * ImageWidget.eq —— 同位置只在 url/width/align 任一变化时重建（§4.2）。alt 不进渲染，故不入 eq。
 */
describe('ImageWidget.eq', () => {
  const base = () => new ImageWidget('oru-doc-img://local/a.png', 320, 'center', 'a.png', '');

  it('三者全等 → true（复用，不重建）', () => {
    expect(base().eq(new ImageWidget('oru-doc-img://local/a.png', 320, 'center', 'a.png', ''))).toBe(
      true,
    );
  });

  it('alt 变但 url/width/align 不变 → 仍 true（alt 不进 eq）', () => {
    expect(
      base().eq(new ImageWidget('oru-doc-img://local/a.png', 320, 'center', 'a.png', '配图')),
    ).toBe(true);
  });

  it('url 变 → false', () => {
    expect(
      base().eq(new ImageWidget('oru-doc-img://local/b.png', 320, 'center', 'b.png', '')),
    ).toBe(false);
  });

  it('width 变（含 null）→ false', () => {
    expect(base().eq(new ImageWidget('oru-doc-img://local/a.png', 200, 'center', 'a.png', ''))).toBe(
      false,
    );
    expect(base().eq(new ImageWidget('oru-doc-img://local/a.png', null, 'center', 'a.png', ''))).toBe(
      false,
    );
  });

  it('align 变 → false', () => {
    expect(base().eq(new ImageWidget('oru-doc-img://local/a.png', 320, 'left', 'a.png', ''))).toBe(
      false,
    );
  });
});
