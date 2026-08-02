/**
 * AnySearch 适配器 fixture 单测（AnySearch 接入·批 1）
 *
 * 覆盖：响应映射（原生 title/url/snippet）、正文完整性判定（<300 不填 / ≥3800 标
 * 截断，判据依据 techdoc 实测）、字段缺失容错、HTTP / 请求形状（endpoint、Bearer、
 * max_results）、test() 三态。fetch 用真 Response 构造 fixture——不造 as 蒙混的假对象。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnySearchEngine } from '../../electron/main/search/engines/anysearch';

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 真实响应外层裹一层信封 { code, message, data: { results } }——fixture 必须照契约裹，否则跟错误代码自洽假绿。 */
function envelope(results: unknown[]): Record<string, unknown> {
  return { code: 0, message: 'success', request_id: 'test', data: { results } };
}

afterEach(() => vi.unstubAllGlobals());

describe('AnySearchEngine.search', () => {
  it('响应映射：原生 title/url/snippet 直取；短正文（<300 字）视为抓取失败不填 content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResp(
        envelope([
          {
            title: 'TypeScript 官网',
            url: 'https://ts.dev/',
            snippet: '正文开头约 300 字…',
            content: '只抓到导航菜单的短内容', // <300 字：失败签名，宁缺勿滥
          },
        ]),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const engine = new AnySearchEngine('k-test');
    const items = await engine.search('typescript', { count: 5 });

    expect(items).toEqual([
      { title: 'TypeScript 官网', url: 'https://ts.dev/', snippet: '正文开头约 300 字…' },
    ]);
    // 请求形状：端点 / Bearer / max_results
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.anysearch.com/v1/search');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k-test');
    expect(JSON.parse(init.body as string)).toEqual({ query: 'typescript', max_results: 5 });
  });

  it('字段缺失容错：无 url 条目丢弃；title 缺失回落 url；snippet 缺失回落空串', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResp(
          envelope([
            { title: '没 url 的条目', snippet: 'x' },
            { url: 'https://a.dev/' },
          ]),
        ),
      ),
    );

    const items = await new AnySearchEngine('k').search('q', {});
    expect(items).toEqual([{ title: 'https://a.dev/', url: 'https://a.dev/', snippet: '' }]);
  });

  it('正文完整性判定：300–3799 字 complete:true；≥3800 字疑似截断 complete:false（含边界）', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResp(
          envelope([
            { url: 'https://short.dev/', title: 'short', content: 'z'.repeat(299) }, // <300：不填
            { url: 'https://edge.dev/', title: 'edge', content: 'e'.repeat(300) }, // 恰 300：填、完整
            { url: 'https://ok.dev/', title: 'ok', content: 'x'.repeat(1000) },
            { url: 'https://cut-edge.dev/', title: 'cutEdge', content: 'c'.repeat(3800) }, // 恰 3800：截断
            { url: 'https://cut.dev/', title: 'cut', content: 'y'.repeat(3900) },
          ]),
        ),
      ),
    );
    const items = await new AnySearchEngine('k').search('q', {});
    expect(items[0].content).toBeUndefined();
    expect(items[1].content).toEqual({ text: 'e'.repeat(300), complete: true });
    expect(items[2].content).toEqual({ text: 'x'.repeat(1000), complete: true });
    expect(items[3].content).toEqual({ text: 'c'.repeat(3800), complete: false });
    expect(items[4].content).toEqual({ text: 'y'.repeat(3900), complete: false });
  });

  it('data 信封或 results 缺失 → 空数组（不抛）', async () => {
    for (const body of [{}, { code: 0, message: 'success', data: {} }]) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResp(body)));
      expect(await new AnySearchEngine('k').search('q', {})).toEqual([]);
    }
  });

  it('HTTP 非 2xx → 抛带状态码与响应体摘录的错误', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('quota exceeded', { status: 429 })),
    );
    await expect(new AnySearchEngine('k').search('q', {})).rejects.toThrow(
      /AnySearch HTTP 429.*quota exceeded/,
    );
  });
});

describe('AnySearchEngine.test', () => {
  it('有结果 → ok:true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResp(envelope([{ url: 'https://a.dev/', title: 'a' }]))),
    );
    expect(await new AnySearchEngine('k').test()).toEqual({ ok: true });
  });

  it('API 200 但 0 条 → ok:false（同博查口径）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResp(envelope([]))));
    const r = await new AnySearchEngine('k').test();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('0 条');
  });

  it('请求异常 → ok:false 带 message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const r = await new AnySearchEngine('k').test();
    expect(r.ok).toBe(false);
    expect(r.error).toContain('ECONNREFUSED');
  });
});

describe('AnySearchEngine 接口面', () => {
  it('不实现 fetch / searchImages（抓页走 selector 通用路径兜底）', () => {
    const engine = new AnySearchEngine('k');
    expect(engine.fetch).toBeUndefined();
    expect(engine.searchImages).toBeUndefined();
    expect(engine.type).toBe('anysearch');
  });
});
