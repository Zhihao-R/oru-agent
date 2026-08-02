/**
 * web_fetch 与搜索引擎闸彻底解耦（打磨 8，2026-08-01 PM 拍板）。
 *
 * 拍板语义：「启用上网搜索」管的是搜索引擎；读用户直接给的 URL 本就不需要引擎——
 * enabled=false / 一个引擎都没配，fetchWithFallback 都照走 genericHttpFetch（SSRF 防护在）。
 * 搜索 / 搜图路径不变：engines 为空仍抛 no_engines_configured、未启用仍抛 not_enabled。
 *
 * 走真实链路：ORU_DIR 沙箱写 config + stub 全局 fetch——只 mock 网络边界与 agent 元数据。
 */
// 注意：electron 模块全部动态 import——静态 import 会被提升到 process.env.ORU_DIR 赋值之前
// 求值，paths 捕获默认 ~/.oru（vitest ORU_DIR 隔离陷阱），测试会读到真实配置假绿。
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Agent, ChatMessage } from '@shared/types';
import type { fetchWithFallback as fetchWithFallbackT, searchWithFallback as searchWithFallbackT } from '../../electron/main/search/selector';
import type { makeWebFetchTool as makeWebFetchToolT } from '../../electron/main/agent/agentTools/webFetch';
import type { makeWebSearchTool as makeWebSearchToolT } from '../../electron/main/agent/agentTools/webSearch';

const ORU_DIR = join(tmpdir(), `oru-test-fetch-decoupled-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const configFile = join(ORU_DIR, 'users', 'local-user', 'config.json');

vi.mock('../../electron/main/i18n/effectiveLang', () => ({ resolveEffectiveLang: () => 'zh' }));
vi.mock('../../electron/main/agent/store/agents', () => ({
  getAgent: vi.fn(
    async (id: string): Promise<Agent> => ({
      id,
      ownerId: 'local-user',
      name: 'Twin',
      homePath: '/tmp/h',
      systemPromptAppend: null,
      approvalMode: 'work',
      createdAt: 0,
      avatarPath: null,
    }),
  ),
}));
vi.mock('../../electron/main/conversations/store', () => ({
  readHistory: vi.fn(async (): Promise<ChatMessage[]> => [
    {
      id: 'm0',
      conversationId: 'conv_1',
      role: 'user' as const,
      text: '帮我看下 https://example.com/page 这页',
      toolCalls: [],
      createdAt: 1,
      done: true,
    },
  ]),
}));
vi.mock('../../electron/main/identity/getCurrentOwnerId', () => ({
  getCurrentOwnerId: () => 'local-user',
}));
vi.mock('../../electron/main/search/budget', () => ({
  consumeBudget: vi.fn(() => true),
  getMaxBudget: () => 100,
}));
vi.mock('../../electron/main/search/summarizer', () => ({
  summarizeIfNeeded: async (text: string) => ({ summarized: false, text }),
}));

import { makeToolContext } from '../helpers/toolContext';

let fetchWithFallback: typeof fetchWithFallbackT;
let searchWithFallback: typeof searchWithFallbackT;
let makeWebFetchTool: typeof makeWebFetchToolT;
let makeWebSearchTool: typeof makeWebSearchToolT;
let clearStoreCache: () => void;

const PAGE_HTML = '<!doctype html><html><head><title>测试页</title></head><body><p>正文内容</p></body></html>';

async function writeConfig(webSearch: unknown): Promise<void> {
  await fs.writeFile(
    configFile,
    JSON.stringify({ projects: [], activeId: null, settings: { webSearch } }),
    'utf-8',
  );
  clearStoreCache(); // projects/store 有 ownerId 级缓存——改写后必须清，否则读到上一份
}

beforeAll(async () => {
  await fs.mkdir(join(ORU_DIR, 'users', 'local-user'), { recursive: true });
  ({ fetchWithFallback, searchWithFallback } = await import('../../electron/main/search/selector'));
  ({ makeWebFetchTool } = await import('../../electron/main/agent/agentTools/webFetch'));
  ({ makeWebSearchTool } = await import('../../electron/main/agent/agentTools/webSearch'));
  ({ __clearCacheForTest: clearStoreCache } = await import('../../electron/main/projects/store'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input);
      if (url.startsWith('https://example.com/')) {
        return new Response(PAGE_HTML, { status: 200, headers: { 'content-type': 'text/html' } });
      }
      throw new Error(`未预期的请求：${url}`);
    }),
  );
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});
beforeEach(async () => {
  await writeConfig({ enabled: true, engines: [], longPageSummary: false });
});

describe('fetchWithFallback 拆闸（打磨 8）', () => {
  it('enabled=true 但 engines 为空 → 走 generic 成功（不再 no_engines_configured）', async () => {
    const r = await fetchWithFallback('https://example.com/page', new AbortController().signal);
    expect(r.engineUsed).toBe('generic');
    expect(r.raw.text).toContain('正文内容');
  });

  it('enabled=false → 照样抓（拍板：彻底解耦，读 URL 不需要引擎）', async () => {
    await writeConfig({ enabled: false, engines: [], longPageSummary: false });
    const r = await fetchWithFallback('https://example.com/page', new AbortController().signal);
    expect(r.engineUsed).toBe('generic');
    expect(r.raw.text).toContain('正文内容');
  });

  it('回归：searchWithFallback 在 engines 为空时仍抛 no_engines_configured（搜索路径不变）', async () => {
    await expect(searchWithFallback('q', new AbortController().signal)).rejects.toMatchObject({
      kind: 'no_engines_configured',
    });
    await writeConfig({ enabled: false, engines: [] });
    await expect(searchWithFallback('q', new AbortController().signal)).rejects.toMatchObject({
      kind: 'not_enabled',
    });
  });
});

describe('工具层（打磨 8）', () => {
  it('web_fetch：engines 为空 + 用户逐字 URL → 抓到内容、不出现引擎配置文案', async () => {
    const tool = makeWebFetchTool();
    const r = await tool.execute(
      { url: 'https://example.com/page' },
      makeToolContext({ conversationId: 'conv_1', agentId: 'twin', ownerId: 'local-user' }),
    );
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('正文内容');
    expect(r.text).not.toContain('引擎');
  });

  it('web_search：engines 为空 → 错误文案指向真实存在的设置页（设置 › 能力 › Web 搜索）', async () => {
    const tool = makeWebSearchTool();
    const r = await tool.execute(
      { query: 'anything' },
      makeToolContext({ conversationId: 'conv_1', agentId: 'twin', ownerId: 'local-user' }),
    );
    expect(r.isError).toBe(true);
    expect(r.text).toContain('设置 › 能力 › Web 搜索');
  });
});
