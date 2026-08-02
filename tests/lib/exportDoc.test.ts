import { describe, it, expect, vi, beforeEach } from 'vitest';

// mock ws：拦截 request，断言发出的 payload
const request = vi.fn();
vi.mock('@/lib/ws', () => ({ wsClient: { request: (...a: unknown[]) => request(...a) } }));

import { exportDoc } from '@/lib/exportDoc';

describe('exportDoc', () => {
  beforeEach(() => request.mockReset());

  it('空文档：不发请求、回友好提示（PRD 护栏，渲染端前置拦截）', async () => {
    const r = await exportDoc({ projectId: 'p1', path: 'a.md', content: '  \n ', format: 'html' });
    expect(request).not.toHaveBeenCalled();
    expect(r.ok).toBe(false);
    expect(r.message).toBeTruthy();
  });

  it('HTML 导出：发 doc.export，html 完整自包含正文、format=html、文件名进 title', async () => {
    request.mockResolvedValue({ type: 'doc.export.result', ok: true, path: '/x/报告.html' });
    const r = await exportDoc({ projectId: 'p1', path: '笔记/报告.md', content: '# 报告', format: 'html' });
    expect(r).toEqual({ ok: true, path: '/x/报告.html', cancelled: undefined, message: undefined });
    const payload = request.mock.calls[0][0] as { type: string; format: string; html: string; path: string };
    expect(payload.type).toBe('doc.export');
    expect(payload.format).toBe('html');
    expect(payload.path).toBe('笔记/报告.md');
    expect(payload.html).toContain('class="oru-chat-md"');
    expect(payload.html).toContain('<title>报告</title>'); // 文件名（去扩展名）进标题
    expect(payload.html).toContain('export-theme: book'); // HTML 恒书本风
  });

  it('PDF 纸张版：format=pdf、paperMode=true、html 注入 paper 主题', async () => {
    request.mockResolvedValue({ type: 'doc.export.result', ok: true, path: '/x/报告.pdf' });
    await exportDoc({ projectId: 'p1', path: '报告.md', content: '# x', format: 'pdf', paperMode: true });
    const payload = request.mock.calls[0][0] as { format: string; paperMode: boolean; html: string };
    expect(payload.format).toBe('pdf');
    expect(payload.paperMode).toBe(true);
    expect(payload.html).toContain('export-theme: paper');
  });

  it('PDF 默认（非纸张版）：paperMode=false、html 书本风', async () => {
    request.mockResolvedValue({ type: 'doc.export.result', ok: true });
    await exportDoc({ projectId: 'p1', path: '报告.md', content: '# x', format: 'pdf', paperMode: false });
    const payload = request.mock.calls[0][0] as { paperMode: boolean; html: string };
    expect(payload.paperMode).toBe(false);
    expect(payload.html).toContain('export-theme: book');
  });

  it('HTML 出口忽略 paperMode（恒书本风）', async () => {
    request.mockResolvedValue({ type: 'doc.export.result', ok: true });
    await exportDoc({ projectId: 'p1', path: 'a.md', content: '# x', format: 'html', paperMode: true });
    const payload = request.mock.calls[0][0] as { html: string; paperMode?: boolean };
    expect(payload.html).toContain('export-theme: book');
  });

  it('缺图清单透传给 UI（成功但部分图未内联）', async () => {
    request.mockResolvedValue({ type: 'doc.export.result', ok: true, path: '/x/a.html', missing: ['a.assets/x.png'] });
    const r = await exportDoc({ projectId: 'p1', path: 'a.md', content: '# x', format: 'html' });
    expect(r.ok).toBe(true);
    expect(r.missing).toEqual(['a.assets/x.png']);
  });

  it('后端报失败：透传 message', async () => {
    request.mockResolvedValue({ type: 'doc.export.result', ok: false, message: '磁盘写不进' });
    const r = await exportDoc({ projectId: 'p1', path: 'a.md', content: '# x', format: 'html' });
    expect(r.ok).toBe(false);
    expect(r.message).toBe('磁盘写不进');
  });
});
