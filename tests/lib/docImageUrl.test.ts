import { describe, it, expect } from 'vitest';
import { docImageUrl, type DocIdentity } from '@/lib/docImageUrl';

describe('docImageUrl', () => {
  const identity: DocIdentity = { projectId: 'proj-1', docPath: '笔记/报告.md' };

  it('把相对引用编成 oru-doc-img:// URL，文档身份与图引用各逐段编码', () => {
    const url = docImageUrl('报告.assets/图 1.png', identity);
    // 前两段是文档身份（各整段编码，含其中的 /），其后是逐段编码的图引用
    expect(url).toBe(
      `oru-doc-img://local/${encodeURIComponent('proj-1')}/${encodeURIComponent('笔记/报告.md')}/${encodeURIComponent('报告.assets')}/${encodeURIComponent('图 1.png')}`,
    );
  });

  it('与协议解析往返一致：编出的 URL 能被 parseDocImageUrl 还原', async () => {
    const { parseDocImageUrl } = await import('../../electron/main/fs/docImageProtocol');
    const url = docImageUrl('报告.assets/p.png', identity);
    const parsed = parseDocImageUrl(url);
    expect(parsed).toEqual({
      projectId: 'proj-1',
      docPath: '笔记/报告.md',
      imageRef: '报告.assets/p.png',
    });
  });

  it('无文档身份回空串（<img> 走缺失占位）', () => {
    expect(docImageUrl('x.png', null)).toBe('');
  });
});
