/**
 * Tavily 搜索 / 抓取适配器
 * - search: https://api.tavily.com/search
 * - extract: https://api.tavily.com/extract（专属 fetch，比通用 HTTP fetch 更省事）
 *
 * 境外，需代理。
 */
import type {
  FetchOpts,
  ImageResultItem,
  RawFetchResult,
  SearchEngine,
  SearchOpts,
  SearchResultItem,
} from '../types';

type TavilySearchResponse = {
  results?: Array<{
    title?: string;
    url?: string;
    content?: string;
    score?: number;
  }>;
  /** include_images=true 时顶层返回；include_image_descriptions=true 时带 description */
  images?: Array<{ url?: string; description?: string }>;
};

type TavilyExtractResponse = {
  results?: Array<{
    url?: string;
    raw_content?: string;
  }>;
  failed_results?: Array<{ url?: string; error?: string }>;
};

const SEARCH_ENDPOINT = 'https://api.tavily.com/search';
const EXTRACT_ENDPOINT = 'https://api.tavily.com/extract';

export class TavilyEngine implements SearchEngine {
  readonly type = 'tavily' as const;
  readonly displayName = 'Tavily';
  readonly requiresProxy = true;
  readonly strengths = '境外信源、英文内容强';

  constructor(private readonly apiKey: string) {}

  async search(query: string, opts: SearchOpts): Promise<SearchResultItem[]> {
    const res = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: opts.count ?? 8,
        include_raw_content: false,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`Tavily HTTP ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as TavilySearchResponse;
    const items = data.results ?? [];
    return items
      .filter((it) => typeof it.url === 'string' && it.url.length > 0)
      .map<SearchResultItem>((it) => ({
        title: (it.title ?? it.url ?? '').toString(),
        url: it.url as string,
        snippet: (it.content ?? '').toString(),
        score: it.score,
      }));
  }

  async searchImages(query: string, opts: SearchOpts): Promise<ImageResultItem[]> {
    // 同 /search 端点，加 include_images / include_image_descriptions 两个 flag。
    const res = await fetch(SEARCH_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        query,
        max_results: opts.count ?? 8,
        include_raw_content: false,
        include_images: true,
        include_image_descriptions: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`Tavily HTTP ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as TavilySearchResponse;
    return mapTavilyImages(data);
  }

  async fetch(url: string, opts: FetchOpts): Promise<RawFetchResult> {
    const res = await globalThis.fetch(EXTRACT_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: this.apiKey,
        urls: [url],
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`Tavily extract HTTP ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as TavilyExtractResponse;
    const ok = data.results?.[0];
    if (!ok || !ok.raw_content) {
      const failed = data.failed_results?.[0];
      throw new Error(`Tavily extract failed: ${failed?.error ?? 'no content'}`);
    }
    return {
      url: ok.url ?? url,
      title: '', // Tavily extract 不返回 title
      text: ok.raw_content,
    };
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

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return '<no body>';
  }
}

/**
 * Tavily 原始响应 → 统一 ImageResultItem[]（纯函数，单测喂 fixture）。
 * Tavily 不分缩略/原图、无宽高：thumbnailUrl = contentUrl = url（viewing 靠本地 canvas 降采样）。
 */
export function mapTavilyImages(data: TavilySearchResponse): ImageResultItem[] {
  const out: ImageResultItem[] = [];
  for (const it of data.images ?? []) {
    if (!it.url) continue;
    out.push({ thumbnailUrl: it.url, contentUrl: it.url, description: it.description });
  }
  return out;
}
