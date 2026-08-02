/**
 * 正文预存写入路径（AnySearch 接入·批 3）：searchWithFallback 成功返回前，把带 content
 * 的条目写进 contentCache 并剥离 content 字段——工具层与既有消费方看到的结构不变。
 *
 * 走真实链路（同 selectorPreferred.test 范式）：ORU_DIR 沙箱写原始 config + stub 全局
 * fetch 返回带 content 的 AnySearch 响应，只 mock 网络边界。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-content-prestore-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const userDir = join(ORU_DIR, 'users', 'local-user');

beforeAll(async () => {
  await fs.mkdir(userDir, { recursive: true });
  await fs.writeFile(
    join(userDir, 'config.json'),
    JSON.stringify({
      projects: [],
      activeId: null,
      settings: {
        webSearch: {
          enabled: true,
          engines: [{ id: 'eng_a', type: 'anysearch', apiKey: 'ak' }],
          longPageSummary: true,
        },
      },
    }),
    'utf-8',
  );
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

afterEach(() => vi.unstubAllGlobals());

describe('searchWithFallback · 正文预存', () => {
  it('带 content 的条目：结果里 content 被剥离，正文与完整性进 contentCache', async () => {
    const { searchWithFallback } = await import('../../electron/main/search/selector');
    const { getContent, __clearContentCacheForTest } = await import(
      '../../electron/main/search/contentCache'
    );
    __clearContentCacheForTest();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            code: 0,
            message: 'success',
            data: {
              results: [
                { title: '全文页', url: 'https://full.dev/', snippet: 's', content: 'x'.repeat(1000) },
                { title: '截断页', url: 'https://cut.dev/', snippet: 's', content: 'y'.repeat(3900) },
                { title: '无正文页', url: 'https://none.dev/', snippet: 's' },
              ],
            },
          }),
          { status: 200 },
        ),
      ),
    );

    const r = await searchWithFallback('q', new AbortController().signal);

    // 工具层看到的结构不变：所有条目无 content 字段
    expect(r.results).toHaveLength(3);
    for (const it of r.results) expect(it).not.toHaveProperty('content');

    // 缓存按 URL 命中，complete 判定随适配器
    expect(getContent('https://full.dev/')).toEqual({
      text: 'x'.repeat(1000),
      title: '全文页',
      complete: true,
    });
    expect(getContent('https://cut.dev/')?.complete).toBe(false);
    expect(getContent('https://none.dev/')).toBeUndefined();
  });
});
