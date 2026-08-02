/**
 * AnySearch 搜索适配器
 * https://api.anysearch.com/v1/search
 *
 * 境外可直连；技术/学术类查询强，但慢（实测 1.3–5.5s，博查 0.3–0.5s）——定位是
 * fallback 链一员，不动博查的地位。设计与实测数据见
 * docs/tech/2026-07-15-anysearch-engine-integration.md。
 *
 * - snippet 用原生字段而非截 content 填充：两者出自不同管道（snippet 来自搜索索引、
 *   content 来自实时抓取），实测实时抓取翻车的样本里 snippet 均完好——原生字段更稳。
 * - content（正文前 ~4000 字）进 contentCache 供 web_fetch 命中省抓取，完整性判定
 *   在本适配器（截断与失败的签名是引擎知识，见 classifyContent）。
 * - 不实现 fetch / searchImages：抓页由 selector 通用路径兜底；extract 只有 MCP 形态、
 *   REST 端点未文档化，图搜需求未出现。
 */
import type { SearchEngine, SearchOpts, SearchResultItem } from '../types';

/** 响应外层裹一层信封：{ code, message, data: { results } }——结果在 data.results，不在顶层。 */
type AnySearchResponse = {
  data?: {
    results?: Array<{
      title?: string;
      url?: string;
      snippet?: string;
      /** 搜索响应顺带的正文前 ~4000 字——经 classifyContent 判定后进 contentCache */
      content?: string;
    }>;
  };
};

const ENDPOINT = 'https://api.anysearch.com/v1/search';

export class AnySearchEngine implements SearchEngine {
  readonly type = 'anysearch' as const;
  readonly displayName = 'AnySearch';
  readonly requiresProxy = false;
  readonly strengths = '技术/学术、时效类强；较慢（秒级，约为博查 4-10 倍），中文生活服务弱';

  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: SearchOpts): Promise<SearchResultItem[]> {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        max_results: opts.count ?? 8,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`AnySearch HTTP ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as AnySearchResponse;
    return (data.data?.results ?? [])
      .filter((it) => typeof it.url === 'string' && it.url.length > 0)
      .map<SearchResultItem>((it) => {
        const content = classifyContent(it.content);
        return {
          title: (it.title ?? it.url ?? '').toString(),
          url: it.url as string,
          snippet: (it.snippet ?? '').toString(),
          ...(content ? { content } : {}),
        };
      });
  }

  async test(): Promise<{ ok: boolean; error?: string }> {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const items = await this.search('hello', { count: 1, signal: ctrl.signal });
      clearTimeout(t);
      if (items.length === 0) {
        return { ok: false, error: 'API 200 但返回 0 条结果' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }
}

/**
 * 正文完整性判定（引擎知识，依据 2026-07-15 实测，见 techdoc「判断依据」）：
 * - 短于 300 字视为抓取失败不填——n=1 的失败样本只抓到导航菜单（<300 字），判据保守
 *   宁缺勿滥，合法短页被排除的代价只是一次 cache miss；
 * - ≥3800 字视为疑似截断标 complete:false——25 条截断样本长度堆积在 3850–3990，
 *   截断的正文只有开头，web_fetch 消费它会让模型拿残文当全文。
 */
function classifyContent(raw: string | undefined): { text: string; complete: boolean } | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (text.length < 300) return undefined;
  return { text, complete: text.length < 3800 };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<no body>';
  }
}
