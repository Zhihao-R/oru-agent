/**
 * read_file 读 PDF（S34 · G26，锚 conversation-flow.html#Ingest）——.pdf 路径逐页抽文字，产出
 * 带页标记的纯文本，走与普通大文本同一套行分页闸。
 *
 * pathSandbox 放行、pdfText 抽取器 mock（避开真 pdfjs 加载）——本测试只验 read_file 的分流与
 * 页文本的分页行为；真 pdfjs 端到端由 pdfText.ts 自身在集成层覆盖。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeToolContext } from '../helpers/toolContext';

vi.mock('../../electron/main/agent/agentTools/pathSandbox', async (orig) => {
  const actual = await orig<typeof import('../../electron/main/agent/agentTools/pathSandbox')>();
  return { ...actual, assertReadableSandbox: vi.fn(async () => {}) };
});

let pdfText = '';
let pdfShouldThrow = false;
vi.mock('../../electron/main/agent/agentTools/pdfText', () => ({
  extractPdfText: vi.fn(async () => {
    if (pdfShouldThrow) throw new Error('bad pdf');
    return pdfText;
  }),
}));

import { makeReadFileTool } from '../../electron/main/agent/agentTools/readFile';

const ctx = makeToolContext({ conversationId: 'c-pdf', agentId: 'a1', ownerId: 'o1' });

let dir: string;
afterEach(() => {
  pdfText = '';
  pdfShouldThrow = false;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('read_file 读 PDF（G26）', () => {
  it('.pdf → 逐页抽文字，含页标记', async () => {
    pdfText = '--- 第 1 页 / 共 2 页 ---\nHello page one\n\n--- 第 2 页 / 共 2 页 ---\nSecond page';
    dir = mkdtempSync(join(tmpdir(), 'readpdf-'));
    const p = join(dir, 'doc.pdf');
    writeFileSync(p, Buffer.from([0x25, 0x50, 0x44, 0x46])); // %PDF（内容不重要，抽取器已 mock）

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.images).toBeUndefined();
    expect(res.text).toContain('第 1 页 / 共 2 页');
    expect(res.text).toContain('Hello page one');
    expect(res.text).toContain('Second page');
  });

  it('解析失败 → isError（不静默返回空）', async () => {
    pdfShouldThrow = true;
    dir = mkdtempSync(join(tmpdir(), 'readpdf-'));
    const p = join(dir, 'enc.pdf');
    writeFileSync(p, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.isError).toBe(true);
    expect(res.text).toContain('PDF 解析失败');
  });

  it('超长 PDF → 复用大文件行分页闸（回开头 + offset 续读提示）', async () => {
    // 造 3000 行页文本，触发 MAX_LINES(2000) 闸
    const body = Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n');
    pdfText = `--- 第 1 页 / 共 1 页 ---\n${body}`;
    dir = mkdtempSync(join(tmpdir(), 'readpdf-'));
    const p = join(dir, 'big.pdf');
    writeFileSync(p, Buffer.from([0x25, 0x50, 0x44, 0x46]));

    const res = await makeReadFileTool().execute({ path: p }, ctx);
    expect(res.isError).toBeFalsy();
    expect(res.text).toContain('offset=');
  });
});
