import { beforeEach, describe, expect, it, vi } from 'vitest';

// mock ws：拦 fs.writeImage 请求，回 fs.image.written
const requestMock = vi.fn();
vi.mock('@/lib/ws', () => ({
  wsClient: { request: (...a: unknown[]) => requestMock(...a) },
}));

import { uploadDocImage, imageExtForMime } from '@/lib/docImageUpload';

function fileOf(bytes: number, type: string, name = ''): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

beforeEach(() => {
  requestMock.mockReset();
  requestMock.mockResolvedValue({ type: 'fs.image.written', ref: '方案.assets/图.png' });
});

describe('imageExtForMime', () => {
  it('四种受支持 mime → 扩展名（含点）', () => {
    expect(imageExtForMime('image/png')).toBe('.png');
    expect(imageExtForMime('image/jpeg')).toBe('.jpg');
    expect(imageExtForMime('image/gif')).toBe('.gif');
    expect(imageExtForMime('image/webp')).toBe('.webp');
  });
  it('非图片 mime → null', () => {
    expect(imageExtForMime('text/plain')).toBeNull();
    expect(imageExtForMime('image/svg+xml')).toBeNull();
  });
});

describe('uploadDocImage', () => {
  it('合法图：发 fs.writeImage（带 docPath/base/ext），回相对引用', async () => {
    const ref = await uploadDocImage('p1', 'docs/方案.md', fileOf(10, 'image/png', 'shot.png'));
    expect(ref).toBe('方案.assets/图.png');
    const sent = requestMock.mock.calls[0][0];
    expect(sent).toMatchObject({
      type: 'fs.writeImage',
      projectId: 'p1',
      docPath: 'docs/方案.md',
      preferredBase: 'shot',
      ext: '.png',
    });
    expect(typeof sent.base64).toBe('string');
  });

  it('剪贴板截图无文件名 → 默认基名「图片」', async () => {
    await uploadDocImage('p1', 'docs/方案.md', fileOf(10, 'image/png'));
    expect(requestMock.mock.calls[0][0].preferredBase).toBe('图片');
  });

  it('非图片 → 直接 null，不发 IPC', async () => {
    const ref = await uploadDocImage('p1', 'docs/方案.md', fileOf(10, 'text/plain', 'a.txt'));
    expect(ref).toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('超过单张 5 MB 上限 → null，不发 IPC', async () => {
    const big = fileOf(5 * 1024 * 1024 + 1, 'image/png', 'huge.png');
    expect(await uploadDocImage('p1', 'docs/方案.md', big)).toBeNull();
    expect(requestMock).not.toHaveBeenCalled();
  });
});
