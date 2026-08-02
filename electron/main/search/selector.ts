/**
 * 多引擎 selector：按优先级自动 fallback 的 search/fetch 调度。
 *
 * - searchWithFallback：按 settings.webSearch.engines 顺序试，一家失败切下一家
 * - fetchWithFallback：引擎实现了 fetch 就用引擎；没有就走通用 HTTP fetch（含 SSRF 防护）
 * - consecutiveFailures：仅放进程内存（模块级 Map），重启清零；用于 Settings 徽标
 */
import TurndownService from 'turndown';

import type { SearchEngineConfig, SearchEngineType, WebSearchSettings } from '@shared/types';
import { getSettings } from '../projects/store';
import { putContent } from './contentCache';
import { AnySearchEngine } from './engines/anysearch';
import { BochaEngine } from './engines/bocha';
import { TavilyEngine } from './engines/tavily';
import { safeFetchManual } from './safeFetch';
import {
  type FetchFailureKind,
  type FetchResult,
  type ImageSearchResult,
  type RawFetchResult,
  type SearchEngine,
  type SearchResult,
  type SearchResultItem,
  WebSearchError,
} from './types';

// ─── consecutiveFailures：模块级 Map ───────────────────────────

const consecutiveFailures = new Map<string, number>();

function bumpFailure(engineId: string): void {
  consecutiveFailures.set(engineId, (consecutiveFailures.get(engineId) ?? 0) + 1);
}

function resetFailure(engineId: string): void {
  consecutiveFailures.set(engineId, 0);
}

export function getConsecutiveFailures(engineId: string): number {
  return consecutiveFailures.get(engineId) ?? 0;
}

/** 仅测试用 */
export function __resetFailureMapForTest(): void {
  consecutiveFailures.clear();
}

// ─── engine factory ────────────────────────────────────────────

export function makeEngine(cfg: SearchEngineConfig): SearchEngine {
  switch (cfg.type) {
    case 'bocha':
      return new BochaEngine(cfg.apiKey);
    case 'tavily':
      return new TavilyEngine(cfg.apiKey);
    case 'anysearch':
      return new AnySearchEngine(cfg.apiKey);
    default: {
      const _: never = cfg.type;
      throw new Error(`unknown search engine type: ${String(_)}`);
    }
  }
}

// ─── public APIs ───────────────────────────────────────────────

/** 引擎有效性的唯一谓词——「prompt 清单列谁」与「searchWithFallback 试谁」必须同一判定。 */
export function isConfiguredEngine(c: SearchEngineConfig): boolean {
  return c.apiKey.trim().length > 0;
}

async function loadConfigs(): Promise<SearchEngineConfig[]> {
  const settings = await getSettings();
  const ws: WebSearchSettings | undefined = settings.webSearch;
  if (!ws?.enabled) {
    throw new WebSearchError('not_enabled');
  }
  const valid = ws.engines.filter(isConfiguredEngine);
  if (valid.length === 0) {
    throw new WebSearchError('no_engines_configured');
  }
  return valid;
}

export async function searchWithFallback(
  query: string,
  signal: AbortSignal,
  preferred?: string,
): Promise<SearchResult> {
  const configs = await loadConfigs();
  const errors: { type: SearchEngineType; error: string }[] = [];

  // 模型自选引擎：preferred 排到首位，其余保持用户配置顺序兜底——选错引擎最多损失首次
  // 尝试的耗时，搜索不会因此失败。不在有效配置里（被停用/被删除/拼写错）时降级按默认顺序
  // 搜完，由 preferredUnavailable 让工具层在结果头部说明；硬报错仅保留给全引擎失败。
  //
  // preferred 是模型输出，归一 + 清洗收口在这一点：小写化做大小写不敏感匹配；剥换行 + 截长
  // 是安全承重——requested 会被工具层拼进不可信框之外的可信区，不清洗等于给「被外部内容
  // 说服的模型」留一条把任意文本写进可信区的注入链。
  const want = (preferred ?? '').trim().toLowerCase().replace(/[\r\n]+/g, ' ').slice(0, 64);
  const preferredIdx = want ? configs.findIndex((c) => c.type === want) : -1;
  const ordered =
    preferredIdx >= 0
      ? [configs[preferredIdx], ...configs.filter((_, i) => i !== preferredIdx)]
      : configs;
  const preferredUnavailable =
    want && preferredIdx < 0
      ? {
          requested: want,
          available: configs.map((c) => ({ type: c.type, strengths: makeEngine(c).strengths })),
        }
      : undefined;

  for (const cfg of ordered) {
    if (signal.aborted) {
      throw new WebSearchError('all_engines_failed', errors);
    }
    const engine = makeEngine(cfg);
    try {
      const items = await engine.search(query, { count: 8, signal });
      resetFailure(cfg.id);
      return { results: cacheAndStripContent(items), engineUsed: cfg.type, preferredUnavailable };
    } catch (e) {
      bumpFailure(cfg.id);
      errors.push({ type: cfg.type, error: (e as Error).message });
    }
  }
  throw new WebSearchError('all_engines_failed', errors);
}

/**
 * 正文预存：带 content 的条目写进 contentCache（web_fetch 命中省抓取）并剥离该字段——
 * 工具层与既有消费方看到的结构不变，每条摘要截 400 字的噪音控制漏斗不被正文放大。
 */
function cacheAndStripContent(items: SearchResultItem[]): SearchResultItem[] {
  return items.map((it) => {
    if (!it.content) return it;
    putContent(it.url, { text: it.content.text, title: it.title, complete: it.content.complete });
    const { content: _stripped, ...rest } = it;
    return rest;
  });
}

/**
 * 图片搜索的多引擎 fallback——镜像 searchWithFallback，唯一差别是跳过未实现 searchImages
 * 的引擎（同 fetchWithFallback 对 fetch? 的处理）。复用同一个 loadConfigs（同 enabled 闸门、
 * 同引擎配置），故联网没开/没配引擎时这里同样抛 not_enabled / no_engines_configured。
 */
export async function searchImagesWithFallback(
  query: string,
  signal: AbortSignal,
  count = 8,
): Promise<ImageSearchResult> {
  const configs = await loadConfigs();
  const errors: { type: SearchEngineType; error: string }[] = [];

  for (const cfg of configs) {
    if (signal.aborted) {
      throw new WebSearchError('all_engines_failed', errors);
    }
    const engine = makeEngine(cfg);
    if (typeof engine.searchImages !== 'function') {
      // 记一条原因——否则全员不支持图搜时 errors 为空，文案会误报成"网络全失败"
      errors.push({ type: cfg.type, error: '该引擎不支持图片搜索' });
      continue;
    }
    try {
      const items = await engine.searchImages(query, { count, signal });
      resetFailure(cfg.id);
      return { results: items, engineUsed: cfg.type };
    } catch (e) {
      bumpFailure(cfg.id);
      errors.push({ type: cfg.type, error: (e as Error).message });
    }
  }
  throw new WebSearchError('all_engines_failed', errors);
}

/**
 * 按 HTTP 状态码 / 错误关键词分类失败种类——驱动 web_fetch 错误文案分流。
 * - 4xx（除 408）：semantic（403/404/付费墙等不重试）
 * - 5xx / 超时 / abort / 网络错：network（可重试 browser_navigate）
 */
function classifyHttpFailure(e: unknown): FetchFailureKind {
  const msg = (e as Error).message;
  if (msg.includes('HTTP 4')) return 'semantic'; // 4xx
  if (msg.includes('HTTP 5')) return 'network'; // 5xx
  if (msg.includes('aborted') || msg.includes('Timeout') || msg.includes('timeout')) return 'network';
  return 'network'; // 网络错（DNS / 连接被拒）默认网络类
}

export async function fetchWithFallback(
  url: string,
  signal: AbortSignal,
): Promise<{ raw: RawFetchResult; engineUsed: SearchEngineType | 'generic' }> {
  // 宽松读配置（不走 loadConfigs 的硬前置）：引擎对抓页只是可选加速——真实抓取主路是
  // genericHttpFetch（通用 HTTP + SSRF 防护，零引擎依赖）。「启用上网搜索」管的是搜索引擎，
  // 读用户直接给的 URL 本就不需要引擎（打磨 8 拍板：彻底解耦，enabled=false 照样抓）。
  const ws: WebSearchSettings | undefined = (await getSettings()).webSearch;
  const configs = ws?.enabled ? ws.engines.filter(isConfiguredEngine) : [];
  const errors: { type: SearchEngineType | 'generic'; error: string }[] = [];

  for (const cfg of configs) {
    if (signal.aborted) {
      // abort 是 network 类——允许后续 browser_navigate 重试
      throw new WebSearchError(
        'all_engines_failed',
        errors as { type: SearchEngineType; error: string }[],
        'network',
      );
    }
    const engine = makeEngine(cfg);
    if (typeof engine.fetch !== 'function') continue;
    try {
      const raw = await engine.fetch(url, { signal });
      resetFailure(cfg.id);
      return { raw, engineUsed: cfg.type };
    } catch (e) {
      bumpFailure(cfg.id);
      errors.push({ type: cfg.type, error: (e as Error).message });
    }
  }

  // 所有引擎都没实现 fetch 或都失败 → 走通用 HTTP fetch
  try {
    const raw = await genericHttpFetch(url, signal);
    return { raw, engineUsed: 'generic' };
  } catch (e) {
    errors.push({ type: 'generic', error: (e as Error).message });
    throw new WebSearchError(
      'all_engines_failed',
      errors as { type: SearchEngineType; error: string }[],
      classifyHttpFailure(e),
    );
  }
}

// ─── generic HTTP fetch ────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15000;
const USER_AGENT = 'Oru/0.1 (+https://oru.app)';
const MAX_BYTES = 2 * 1024 * 1024; // 2MB 单页上限

let _turndown: TurndownService | undefined;
function getTurndown(): TurndownService {
  if (!_turndown) {
    _turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    });
    // 去掉脚本 / 样式 / 导航 / 页脚等非正文
    _turndown.remove(['script', 'style', 'noscript', 'nav', 'footer', 'aside', 'iframe']);
  }
  return _turndown;
}

async function genericHttpFetch(url: string, signal: AbortSignal): Promise<RawFetchResult> {
  // 逐跳 SSRF 校验（manual 重定向）——引擎返回的 URL 不可信，防 302 跳内网/云元数据
  return safeFetchManual(
    url,
    {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      timeoutMs: FETCH_TIMEOUT_MS,
      signal,
    },
    async (res) => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await readBoundedText(res, MAX_BYTES);
      const title = extractTitle(html) ?? url;
      const md = htmlToMarkdown(html);
      return { url, title, text: md };
    },
  );
}

/**
 * 边读边截的 Response 字节读取——读够 maxBytes 即停。
 * overflow=true 表示源体积超过上限（已停止读取）：文本路径据此截断、下载路径据此报错。
 * 导出供 download_image 复用同一套"体积上限内拉取"逻辑（决策 5 step3），避免复制。
 */
export async function readBoundedBytes(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; overflow: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = new Uint8Array(await res.arrayBuffer());
    return { bytes: buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf, overflow: buf.byteLength > maxBytes };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        // 读够上限就停，丢掉后面的
        overflow = true;
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        break;
      }
      chunks.push(value);
    }
  }
  const concatLen = chunks.reduce((s, c) => s + c.byteLength, 0);
  const buf = new Uint8Array(concatLen);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return { bytes: buf, overflow };
}

/** 边读边截的 Response 文本读取——读够 maxBytes 即停，超出部分丢弃。 */
export async function readBoundedText(res: Response, maxBytes: number): Promise<string> {
  const { bytes } = await readBoundedBytes(res, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (m) return m[1].trim().replace(/\s+/g, ' ');
  return undefined;
}

function htmlToMarkdown(html: string): string {
  try {
    return getTurndown().turndown(html).trim();
  } catch {
    // 退化：simple strip
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }
}

// ─── 高层 fetch（含注入检测 + 摘要） ──────────────────────────────────
// 这一层是给 web_fetch.execute 直接调用的——为了让本文件聚焦于"引擎调度"，
// 注入检测和摘要在 webFetch.ts 内编排，不放这里。
export type { FetchResult };
