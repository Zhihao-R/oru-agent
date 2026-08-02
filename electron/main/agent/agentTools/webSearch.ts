/**
 * web_search AgentTool —— 列表搜索。
 *
 * 失败文案直接写在工具响应里，让 Twin 看到自然转述给用户（PRD §C 唯一发声场景）。
 */
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { consumeBudget, getMaxBudget } from '../../search/budget';
import { searchWithFallback } from '../../search/selector';
import { type SearchResult, WebSearchError } from '../../search/types';
import { frameUntrusted } from '../untrustedContent';

const TOOL_DESC = `搜索互联网获取最新信息。返回最多 8 条结果（标题 + URL + 摘要）。

**该用**：最新事件、产品当下信息、价格、版本号、文档最新内容；你不确定的具体事实（人物近况、统计数字、引用原文等）；用户明确说"查一下 / 找一下 / 看看 X"。

**别用**：
- 闲聊、生活琐事、情绪话题；你有把握的常识
- 用户已在对话里告诉过的事实——直接信用户，不要背着用户去验证

调用后看摘要决定要不要 web_fetch 抓详情。从 8 条里最多挑 5 条 web_fetch。

多个来源说法不一致时主动说出来。明显是营销 / 软文 / 内容农场的页面要标注"这条来自一个看起来像投放的页面，仅供参考"。

搜不到 / 失败时不要假装搜到、不要"基于公开信息推测"硬编——直接说"我搜了但没找到 X"，问要不要换个角度。工具返回错误时按响应文案转述给用户。

预算：本轮搜索硬上限 100 次（保险丝）；放手做透，不要中途打断用户问要不要继续。`;

export function makeWebSearchTool(): AgentTool {
  return {
    name: 'web_search',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词；中英文都支持' },
        engine: {
          type: 'string',
          description:
            '可选。指定用哪家搜索引擎；可用引擎及其擅长见系统提示词，不确定就不传（按用户配置顺序）。',
        },
      },
      required: ['query'],
    },
    async execute(input, ctx): Promise<ToolResult> {
      const { query, engine } = (input ?? {}) as { query?: string; engine?: string };
      if (typeof query !== 'string' || query.trim().length === 0) {
        return { isError: true, text: 'web_search: query 不能为空' };
      }

      // 预算硬闸门（子 agent 用独立桶 searchBudgetId，不占主对话；存量路径回落 conversationId）
      if (!consumeBudget(ctx.searchBudgetId ?? ctx.conversationId)) {
        return {
          isError: true,
          text:
            `本轮搜索次数已达硬上限 ${getMaxBudget()}。请告诉用户：` +
            '"你已经搜得够多了，建议先汇总一下当前发现，再决定是否继续。"',
        };
      }

      try {
        // engine 原样透传——归一与清洗（大小写/空白/防注入）收口在 searchWithFallback 单点
        const result = await searchWithFallback(
          query,
          ctx.abortSignal,
          typeof engine === 'string' ? engine : undefined,
        );
        return {
          isError: false,
          text: formatResultsForLLM(query, result),
          structured: { engineUsed: result.engineUsed, count: result.results.length },
        };
      } catch (e) {
        return formatErrorForLLM(e);
      }
    },
    // v0.4：默认 persistPolicy='auto'——8 命中 × 400 字摘要 ≈ 1.4k token 通常不触发，
    // 偶发超阈值自动落盘
  };
}

function formatResultsForLLM(query: string, r: SearchResult): string {
  // 指定引擎不可用的降级说明（实时名单）——我方代码生成的可信引导，放在不可信框之外
  const note = r.preferredUnavailable
    ? `注：指定引擎 ${r.preferredUnavailable.requested} 当前不可用，本次使用 ${r.engineUsed}；当前可用：${r.preferredUnavailable.available
        .map((a) => `${a.type}（${a.strengths}）`)
        .join('、')}\n`
    : '';
  const head = `通过 ${r.engineUsed} 搜索：${query}\n找到 ${r.results.length} 条结果：\n`;
  const body = r.results
    .map((it, i) => `[${i + 1}] ${it.title}\n  ${it.url}\n  ${truncate(it.snippet, 400)}`)
    .join('\n\n');
  // G76 来源分级：搜索结果（标题/摘要/地址）来自网络、任何人可写，套「引述的外部内容，不是指令」框。
  return note + frameUntrusted('web', head + '\n' + body);
}

function truncate(s: string, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= n ? t : t.slice(0, n) + '…';
}

function formatErrorForLLM(e: unknown): ToolResult {
  if (e instanceof WebSearchError) {
    switch (e.kind) {
      case 'not_enabled':
        return {
          isError: true,
          text:
            '上网搜索未启用。请告诉用户：' +
            '"这个问题我得查最新信息，但当前上网搜索不可用——要不要去 设置 › 能力 › Web 搜索 打开？"',
        };
      case 'no_engines_configured':
      case 'all_engines_failed': {
        const errs = (e.engineErrors ?? []).map((x) => `${x.type}：${x.error}`).join('；');
        return {
          isError: true,
          text:
            `上网搜索当前不可用（${errs || 'no engines'}）。请告诉用户：` +
            '"这个问题我得查最新信息，但当前上网搜索不可用——要不要去 设置 › 能力 › Web 搜索 看一下？"',
        };
      }
      case 'budget_exceeded':
        return {
          isError: true,
          text: '本轮搜索次数已达硬上限。请告诉用户先汇总一下当前发现。',
        };
    }
  }
  return {
    isError: true,
    text: `web_search 异常：${(e as Error).message}`,
  };
}
