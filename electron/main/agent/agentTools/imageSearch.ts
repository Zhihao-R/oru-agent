/**
 * image_search AgentTool —— 搜图 + 把候选缩略图喂进模型视野，让它"睁眼挑"（决策 1/2/3）。
 *
 * 两段式的第一段（对齐 web_search→web_fetch）：返回一批候选缩略图供挑选，
 * download_image 再把选中那张落地。缩略图经 canvas 归一化成 ≤512px PNG（决策 3），
 * 经任务 1 的 ToolResult.images 通道转 MCP image content 喂回模型。
 *
 * 可见性（决策 8）：把同一批归一化缩略图落到对话 tool-cache，stash 进 toolVisuals 桥，
 * 聊天卡铺出候选网格——不把 base64 内联进历史。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import type { AgentTool, ToolResult, ToolResultImage } from '@shared/agent/backend';
import type { ToolCallVisualThumb } from '@shared/types';
import { conversationToolCacheDir } from '../../runtime/paths';
import { consumeBudget, getMaxBudget } from '../../search/budget';
import { fetchThumbnails } from '../../search/imageThumb';
import { searchImagesWithFallback } from '../../search/selector';
import { WebSearchError } from '../../search/types';
import { formatCandidatesText, parseImageSearchInput } from './imageSearchInput';
import { stashToolVisual } from './toolVisuals';

const TOOL_DESC = `搜索网络图片并把候选缩略图返回给你"看"——你据眼睛挑那张最合这一页的，再用 download_image 下载。

**该用**：给 deck / HTML 配图时找真实图片（照片、实拍、概念图、logo、图标等）。
**别用**：闲聊；你不需要图时；想生成 AI 图（本期不支持）。

流程：image_search(描述想要的图) → 看回来的一排候选缩略图 → 选合适的 → download_image(url=该候选的 contentUrl, dest=<deckPath>/images/xxx.jpg)。
- 按这一页的语境挑（主体/风格/调性对不对），别凭标题盲选——图就在你眼前。
- 下载失败（防盗链 403 等）就从候选里换一张；候选都不行就换关键词重搜。
- 没配联网搜索引擎时本工具不可用（搜图复用联网引擎）。`;

const N_CANDIDATES = 6; // 决策 3：最多看 6 张，控 viewing token（每张 ≤512px ≈ 250 token）
// 向引擎多请求一倍候选：实测约 25% contentUrl 防盗链/坏链（spike ④），多拉一倍才能稳定凑够
// N 张存活缩略图喂给模型，坏的由 fetchThumbnails 按序跳过补位。
const CANDIDATE_REQUEST = N_CANDIDATES * 2;

export function makeImageSearchTool(): AgentTool {
  return {
    name: 'image_search',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '描述想要的图；中英文都支持（如"现代办公室团队协作 俯拍"）' },
      },
      required: ['query'],
    },
    persistPolicy: 'never', // 文字清单短；缩略图走 image content 通道，不进 .tool-cache 文本落盘
    async execute(input, ctx): Promise<ToolResult> {
      const parsed = parseImageSearchInput(input);
      if ('error' in parsed) return { isError: true, text: parsed.error };
      const { query } = parsed;

      // 预算硬闸门（与 web_search 同桶：子 agent 用独立 searchBudgetId，不占主对话）
      if (!consumeBudget(ctx.searchBudgetId ?? ctx.conversationId)) {
        return {
          isError: true,
          text: `本轮搜索次数已达硬上限 ${getMaxBudget()}。请先汇总当前发现，再决定是否继续。`,
        };
      }

      let engineUsed: string;
      let results;
      try {
        const r = await searchImagesWithFallback(query, ctx.abortSignal, CANDIDATE_REQUEST);
        engineUsed = r.engineUsed;
        results = r.results;
      } catch (e) {
        return formatImageSearchError(e);
      }

      if (results.length === 0) {
        return {
          isError: true,
          text: `没搜到"${query}"的图片。换个更具体或更通用的描述再试，或告诉用户这一页暂时配不到合适的图。`,
        };
      }

      // 并发拉 N 张缩略图 + canvas 归一化；坏链/解码失败已跳过（决策 2 部分失败）
      const survived = await fetchThumbnails(results, {
        count: N_CANDIDATES,
        signal: ctx.abortSignal,
      });
      if (survived.length === 0) {
        return {
          isError: true,
          text: `搜到了候选但缩略图都没拉下来（可能防盗链/坏链）。换个关键词重搜试试。`,
        };
      }

      // 落盘缩略图到对话 tool-cache（供聊天卡按引用展示，决策 8）——失败不阻断搜图主流程
      const thumbRefs = await persistThumbnails(ctx, survived);

      // stash 视觉数据：聊天卡铺候选网格（决策 8）
      stashToolVisual(ctx.conversationId, 'image_search', input, {
        kind: 'image_search',
        query,
        engineUsed,
        thumbnails: thumbRefs,
      });

      const images: ToolResultImage[] = survived.map((s) => ({
        base64: s.pngBase64,
        mediaType: 'image/png',
      }));
      const text = formatCandidatesText(
        query,
        engineUsed,
        survived.map((s) => ({
          contentUrl: s.item.contentUrl,
          sourceUrl: s.item.sourceUrl,
          width: s.item.width,
          height: s.item.height,
        })),
      );
      return {
        isError: false,
        text,
        images,
        structured: { engineUsed, candidateCount: survived.length },
      };
    },
  };
}

/** 把存活缩略图写到对话 tool-cache，返回供聊天卡用的轻引用（绝对路径）。写盘失败的那张跳过。 */
async function persistThumbnails(
  ctx: { ownerId: string; agentId: string; conversationId: string },
  survived: Awaited<ReturnType<typeof fetchThumbnails>>,
): Promise<ToolCallVisualThumb[]> {
  const dir = join(
    conversationToolCacheDir(ctx.ownerId, ctx.agentId, ctx.conversationId),
    'image-search',
  );
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    return []; // 建目录失败：聊天卡降级为无缩略图，但搜图主流程（喂模型）已成
  }
  const stamp = Date.now();
  const refs: ToolCallVisualThumb[] = [];
  for (let i = 0; i < survived.length; i += 1) {
    const s = survived[i];
    const imgPath = join(dir, `${stamp}-${i}.png`);
    try {
      await fs.writeFile(imgPath, Buffer.from(s.pngBase64, 'base64'));
      refs.push({
        imgPath,
        sourceUrl: s.item.sourceUrl,
        contentUrl: s.item.contentUrl,
        width: s.item.width,
        height: s.item.height,
      });
    } catch {
      /* 单张写盘失败：跳过该缩略图的卡片展示，不影响其它 */
    }
  }
  return refs;
}

function formatImageSearchError(e: unknown): ToolResult {
  if (e instanceof WebSearchError) {
    switch (e.kind) {
      case 'not_enabled':
        return {
          isError: true,
          text:
            '配图不可用——联网搜索未启用（搜图复用联网引擎）。请告诉用户：' +
            '"想给这页配图得先在 Settings 配上联网搜索（博查/Tavily），配好搜图就一起可用了。"',
        };
      case 'no_engines_configured':
        return {
          isError: true,
          text:
            '配图不可用——没配任何联网搜索引擎。请告诉用户去 设置 › 能力 › Web 搜索 加一个（博查/Tavily），配图复用它。',
        };
      case 'all_engines_failed': {
        const errs = (e.engineErrors ?? []).map((x) => `${x.type}：${x.error}`).join('；');
        return {
          isError: true,
          text: `搜图失败（${errs || 'all failed'}）。告诉用户这页暂时配不到图，或稍后再试。`,
        };
      }
      case 'budget_exceeded':
        return { isError: true, text: '本轮搜索次数已达硬上限。请先汇总当前发现。' };
    }
  }
  return { isError: true, text: `image_search 异常：${(e as Error).message}` };
}
