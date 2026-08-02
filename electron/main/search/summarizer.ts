/**
 * 长网页二次摘要——超过阈值时用调用方对应 backend 的 runOneShot 提炼。
 *
 * 防循环依赖：
 * 1. 用 AsyncLocalStorage 守护——summarizer 内部又触发 web_fetch 时直接退化原文
 * 2. 各 backend 的 runOneShot 实现需保证不注入任何 AgentTool / SDK 内置 web 工具
 *    （ClaudeCodeBackend 在 disallowedTools 里加 WebSearch/WebFetch，§8.2）
 * 3. 摘要这次 LLM 调用不消费搜索预算（不是用户视角的搜索）
 */
import { AsyncLocalStorage } from 'node:async_hooks';

import type { ToolContext } from '@shared/agent/backend';
import { getSettings } from '../projects/store';
import { getBackendFor } from '../agent/backends/factory';
import { instrumentOneShot } from '../debug/instrument';
import { newMessageId } from '@shared/ids';

const SUMMARY_THRESHOLD = 5000;
const SUMMARY_TARGET = 3000;

const inSummarization = new AsyncLocalStorage<true>();

/** 仅测试用 */
export function __isInSummarizationForTest(): boolean {
  return Boolean(inSummarization.getStore());
}

export type SummarizeOutput = {
  text: string;
  summarized: boolean;
};

export async function summarizeIfNeeded(
  text: string,
  ctx: Pick<ToolContext, 'abortSignal' | 'conversationId' | 'agentId' | 'ownerId'>,
): Promise<SummarizeOutput> {
  const settings = await getSettings();
  if (!settings.webSearch?.longPageSummary) return { text, summarized: false };
  if (text.length <= SUMMARY_THRESHOLD) return { text, summarized: false };

  // 嵌套守护：检测到自己已经在跑就放弃
  if (inSummarization.getStore()) {
    // eslint-disable-next-line no-console
    console.warn('[summarizer] nested call detected, falling back to raw text');
    return { text, summarized: false };
  }

  return inSummarization.run(true, async () => {
    try {
      // 小模型提取（G28→G26，锚 conversation-flow.html#Ingest）：网页提取是一次性、便宜、无工具的
      // 文本压缩，不该烧主对话模型。走 conversationSummary 用途——它本就是「廉价摘要器」（上下文整理
      // 也用它），语义最贴近，小模型由用户在该用途分配；不新增独立用途/设置项（克制）。用量账本据此
      // 归入摘要桶。原按 ctx.usage 取（= 主对话同款模型）是本差距的病灶。
      const backend = await getBackendFor('conversationSummary');
      const prompt =
        `下面是一篇网页正文。请用中文提炼出与你最近被问到的问题最相关的部分，控制在 ${SUMMARY_TARGET} 字以内。` +
        '保留事实、数字、引用；去掉营销口水、重复段落。\n\n正文：\n' +
        text;
      const summary = await instrumentOneShot(
        backend,
        {
          roundId: newMessageId(),
          conversationId: ctx.conversationId,
          ownerId: ctx.ownerId,
          agentId: ctx.agentId,
          source: 'web_summary',
          userText: prompt,
        },
        () => backend.runOneShot({ prompt }, ctx.abortSignal),
      );
      return { text: summary.trim(), summarized: true };
    } catch (e) {
      // 摘要失败（API 挂 / 限流 / abort）→ 退化返回原文
      // eslint-disable-next-line no-console
      console.warn('[summarizer] failed, falling back to raw text:', (e as Error).message);
      return { text, summarized: false };
    }
  });
}
