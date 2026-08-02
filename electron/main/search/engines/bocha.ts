/**
 * 博查 AI 搜索（Bocha AI）适配器
 * https://api.bochaai.com/v1/web-search
 *
 * 国内直连、中文友好。返回结构化结果 + 摘要 + sourceURL。
 * 没有专属 fetch endpoint——抓页面走 selector 的通用 HTTP fetch。
 */
import type { ImageResultItem, SearchEngine, SearchOpts, SearchResultItem } from '../types';

type BochaSearchResponse = {
  code?: number;
  msg?: string;
  data?: {
    webPages?: {
      value?: Array<{
        name?: string;
        url?: string;
        snippet?: string;
        summary?: string;
      }>;
    };
    /**
     * 图片结果——博查 /v1/web-search 同端点返回的 Bing 式结构。字段全 optional + 防御性读取：
     * 即便博查改字段名或某字段缺失，mapBochaImages 也只是少几条候选、不抛错。
     * （字段名按 Bing images 习惯取；接入真 key 后若有出入，调整这里与 mapBochaImages 即可。）
     */
    images?: {
      value?: Array<{
        thumbnailUrl?: string;
        contentUrl?: string;
        hostPageUrl?: string;
        name?: string;
        width?: number;
        height?: number;
      }>;
    };
  };
};

const ENDPOINT = 'https://api.bochaai.com/v1/web-search';

export class BochaEngine implements SearchEngine {
  readonly type = 'bocha' as const;
  readonly displayName = '博查';
  readonly requiresProxy = false;
  readonly strengths = '响应快，中文生活服务、国内资讯强';

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
        count: opts.count ?? 8,
        summary: true,
      }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`Bocha HTTP ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as BochaSearchResponse;
    if (data.code !== undefined && data.code !== 200 && data.code !== 0) {
      throw new Error(`Bocha API error: ${data.msg ?? 'unknown'}`);
    }
    const items = data.data?.webPages?.value ?? [];
    return items
      .filter((it) => typeof it.url === 'string' && it.url.length > 0)
      .map<SearchResultItem>((it) => ({
        title: (it.name ?? it.url ?? '').toString(),
        url: it.url as string,
        snippet: (it.summary ?? it.snippet ?? '').toString(),
      }));
  }

  async searchImages(query: string, opts: SearchOpts): Promise<ImageResultItem[]> {
    // 复用 search() 的请求骨架（同端点、同 apiKey、同错误处理），只改读 data.images.value[]。
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, count: opts.count ?? 8 }),
      signal: opts.signal,
    });
    if (!res.ok) {
      throw new Error(`Bocha HTTP ${res.status}: ${await safeText(res)}`);
    }
    const data = (await res.json()) as BochaSearchResponse;
    if (data.code !== undefined && data.code !== 200 && data.code !== 0) {
      throw new Error(`Bocha API error: ${data.msg ?? 'unknown'}`);
    }
    return mapBochaImages(data);
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
 * 博查原始响应 → 统一 ImageResultItem[]（纯函数，单测喂 fixture）。
 * contentUrl 缺省时回落 thumbnailUrl；两者皆无的条目丢弃（无可下载 URL = 无意义候选）。
 */
export function mapBochaImages(data: BochaSearchResponse): ImageResultItem[] {
  const out: ImageResultItem[] = [];
  for (const it of data.data?.images?.value ?? []) {
    const contentUrl = it.contentUrl ?? it.thumbnailUrl;
    if (!contentUrl) continue; // 无可下载 URL = 无意义候选
    out.push({
      thumbnailUrl: it.thumbnailUrl ?? contentUrl,
      contentUrl,
      sourceUrl: it.hostPageUrl,
      description: it.name,
      width: it.width,
      height: it.height,
    });
  }
  return out;
}
