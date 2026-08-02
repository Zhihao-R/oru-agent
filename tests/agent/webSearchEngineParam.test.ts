/**
 * web_search 工具的 engine 参数与降级说明文案（AnySearch 接入·批 2）
 *
 * 覆盖：engine 参数原样透传给 searchWithFallback（归一与清洗收口在 selector，见
 * selectorPreferred.test）；preferredUnavailable → 结果头部一行降级说明（实时名单 +
 * 擅长），且说明在不可信内容框之外（我方生成的可信引导，不能被「不是指令」框削弱）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext, ToolResult } from '@shared/agent/backend';
import type { SearchResult } from '../../electron/main/search/types';

const sel = vi.hoisted(() => ({
  result: undefined as unknown as SearchResult,
  calls: [] as Array<string | undefined>,
}));
vi.mock('../../electron/main/search/selector', () => ({
  searchWithFallback: (async (
    _query: string,
    _signal: AbortSignal,
    preferred?: string,
  ): Promise<SearchResult> => {
    sel.calls.push(preferred);
    return sel.result;
  }) satisfies typeof import('../../electron/main/search/selector').searchWithFallback,
}));

import { makeWebSearchTool } from '../../electron/main/agent/agentTools/webSearch';
import { makeToolContext } from '../helpers/toolContext';

function makeCtx(): ToolContext {
  return makeToolContext({
    conversationId: `conv_${Math.random().toString(36).slice(2)}`, // 每次新桶，避免搜索预算跨用例累积
    agentId: 'twin',
    ownerId: 'local-user',
  });
}

const tool = makeWebSearchTool();

beforeEach(() => {
  sel.calls.length = 0;
  sel.result = {
    results: [{ title: 't', url: 'https://x.dev/', snippet: 's' }],
    engineUsed: 'bocha',
  };
});

describe('engine 参数透传', () => {
  it('传 engine → searchWithFallback 收到该值', async () => {
    await tool.execute({ query: 'q', engine: 'anysearch' }, makeCtx());
    expect(sel.calls).toEqual(['anysearch']);
  });

  it('缺省 / 非字符串 → undefined；字符串原样透传（归一在 selector 单点做）', async () => {
    await tool.execute({ query: 'q' }, makeCtx());
    await tool.execute({ query: 'q', engine: 42 }, makeCtx());
    await tool.execute({ query: 'q', engine: '  ' }, makeCtx());
    expect(sel.calls).toEqual([undefined, undefined, '  ']);
  });
});

describe('指定引擎不可用的降级说明', () => {
  it('结果头部一行说明：不可用引擎、本次使用、实时名单（各附擅长）；说明在不可信框之外', async () => {
    sel.result = {
      results: [{ title: 't', url: 'https://x.dev/', snippet: 's' }],
      engineUsed: 'bocha',
      preferredUnavailable: {
        requested: 'ghost',
        available: [
          { type: 'bocha', strengths: '响应快' },
          { type: 'anysearch', strengths: '技术强' },
        ],
      },
    };
    const r = (await tool.execute({ query: 'q', engine: 'ghost' }, makeCtx())) as ToolResult;
    expect(r.isError).toBe(false);
    expect(r.text).toContain('注：指定引擎 ghost 当前不可用，本次使用 bocha');
    expect(r.text).toContain('bocha（响应快）');
    expect(r.text).toContain('anysearch（技术强）');
    // 说明先于不可信框出现（frameUntrusted 的框头在说明之后）
    expect(r.text.indexOf('注：指定引擎')).toBeLessThan(r.text.indexOf('引述的外部内容'));
  });

  it('无 preferredUnavailable → 不出说明行', async () => {
    const r = (await tool.execute({ query: 'q' }, makeCtx())) as ToolResult;
    expect(r.text).not.toContain('注：指定引擎');
  });
});
