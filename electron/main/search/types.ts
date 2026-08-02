/**
 * 搜索引擎抽象层公共类型。
 */
import type { SearchEngineType } from '@shared/types';

export type SearchResultItem = {
  title: string;
  url: string;
  snippet: string;
  /** 部分引擎返回；UI 不展示，仅用于排序参考 */
  score?: number;
  /**
   * 搜索响应顺带的正文（如 AnySearch 的 content 字段）。完整性判定归适配器——截断与
   * 失败的签名是引擎知识，缓存层不持有引擎魔数。searchWithFallback 返回前把它写进
   * contentCache 并剥离，工具层与既有消费方看不到这个字段。
   */
  content?: { text: string; complete: boolean };
};

export type SearchResult = {
  results: SearchResultItem[];
  /** 实际用了哪家引擎（自动 fallback 后这里反映最终成功的） */
  engineUsed: SearchEngineType;
  /**
   * 模型指定的引擎不在有效配置里（被停用/被删除/拼写错）时填——搜索已按默认顺序降级完成，
   * 工具层据此在结果头部加一行说明，把结果和纠正一次给齐（名单来自调用瞬间的配置，永远实时）。
   */
  preferredUnavailable?: {
    requested: string;
    available: { type: SearchEngineType; strengths: string }[];
  };
};

/**
 * 图片搜索单条结果——图片搜索与网页搜索是"同一组引擎的两种查询模态"，故独立于
 * SearchResultItem（字段完全不同），不复用。详见图片获取技术设计决策 4。
 */
export type ImageResultItem = {
  /** 缩略图 URL（viewing 用）。引擎不分缩略/原图时 = contentUrl */
  thumbnailUrl: string;
  /** 全分辨率原图 URL（download_image 用） */
  contentUrl: string;
  /** 源页面 URL——给模型上下文，也为将来"署名/授权"留口（本期不强制用） */
  sourceUrl?: string;
  /** 引擎给的描述/alt（Tavily 的 description；博查的 name） */
  description?: string;
  width?: number;
  height?: number;
};

export type ImageSearchResult = {
  results: ImageResultItem[];
  /** 实际用了哪家引擎（对齐 SearchResult.engineUsed，可见性显示"用了哪家"） */
  engineUsed: SearchEngineType;
};

export type RawFetchResult = {
  url: string;
  title: string;
  /** 抓回的内容（已转 markdown / 纯文本） */
  text: string;
};

export type FetchResult = {
  url: string;
  title: string;
  /** LLM 看到的最终文本——可能是原文也可能是摘要后的 */
  text: string;
  /** 是否做了二次摘要 */
  summarized: boolean;
  /** 原文字符数 */
  originalLength: number;
  /** 是否检测到注入并已剥离正文 */
  injectionDetected: boolean;
};

export type SearchOpts = {
  count?: number;
  signal?: AbortSignal;
};

export type FetchOpts = {
  signal?: AbortSignal;
};

export interface SearchEngine {
  readonly type: SearchEngineType;
  readonly displayName: string;
  /** 是否需要代理（仅用于 Settings UI 的提示文案） */
  readonly requiresProxy: boolean;
  /**
   * 一句话中文擅长描述，拼进系统提示词供模型按查询类型自选引擎（web_search 的 engine 参数）。
   * 跟适配器走——加第四家引擎时不碰 prompt 代码。喂 AI 的内容，不走 i18n。
   */
  readonly strengths: string;

  search(query: string, opts: SearchOpts): Promise<SearchResultItem[]>;
  /**
   * 引擎专属抓取——可选。
   * 不实现的引擎由 selector 跳过它的 fetch 路径，走通用 HTTP fetch（selector.fetchWithFallback）。
   */
  fetch?(url: string, opts: FetchOpts): Promise<RawFetchResult>;
  /**
   * 图片搜索——可选。未实现的引擎由 selector 的 searchImagesWithFallback 跳过（同 fetch? 的处理）。
   * 各家图片接口/返回结构不同，由引擎各自适配成统一的 ImageResultItem[]。
   */
  searchImages?(query: string, opts: SearchOpts): Promise<ImageResultItem[]>;
  /** 测试连接：发一个最小 query，能 200 就算 ok */
  test(): Promise<{ ok: boolean; error?: string }>;
}

export type WebSearchErrorKind =
  | 'not_enabled'
  | 'no_engines_configured'
  | 'all_engines_failed'
  | 'budget_exceeded';

/**
 * v0.4：fetch 路径的失败种类——驱动 web_fetch 错误文案是否引导 Twin 升级 browser_navigate。
 * - 'network'：可重试类（超时 / 5xx / 网络错 / abort）→ 文案让 Twin 升级 browser_navigate 一次
 * - 'semantic'：不重试类（403 / 404 / paywall）→ 文案让 Twin 直接转述失败
 */
export type FetchFailureKind = 'network' | 'semantic';

export class WebSearchError extends Error {
  kind: WebSearchErrorKind;
  /** 各引擎失败原因（all_engines_failed 时） */
  engineErrors?: { type: SearchEngineType; error: string }[];
  /** 仅 fetch 路径的 'all_engines_failed' 填这个；search 路径不填 */
  failureKind?: FetchFailureKind;

  constructor(
    kind: WebSearchErrorKind,
    engineErrors?: { type: SearchEngineType; error: string }[],
    failureKind?: FetchFailureKind,
  ) {
    super(kind);
    this.kind = kind;
    this.engineErrors = engineErrors;
    this.failureKind = failureKind;
  }
}
