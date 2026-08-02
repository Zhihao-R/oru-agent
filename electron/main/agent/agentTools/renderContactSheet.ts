/**
 * render_contact_sheet AgentTool —— 把当前 deck 逐页渲染、拼成带页码的网格联系表，
 * 作为图像返回给子 agent"看"全局版式（主观自查）。
 *
 * 图走 ToolResult.images → MCP image content 喂模型，**不**经任务 3 的 toolVisuals 桥铺给用户
 * （决策 7：过程只展示文本进度，联系表只喂模型）。deck 路径自 toolContext.deckPath。
 *
 * 大 deck 分批：单次返回网格图上限 MAX_SHEETS_PER_CALL，超出用 batch 入参拿下一批。
 */
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { buildContactSheet, selectSheetBatch } from '../../deck/contactSheet';

const TOOL_DESC = `把当前 deck 逐页渲染、拼成一张带页码的网格联系表给你"看"全局版式。
**该用**：deck 全部页生成/修改完后，整体审一遍版式与节奏（哪几页太挤、配色跳脱、图文比例怪）。
**返回**：一张或多张网格缩略图（每格左上角标页码，1 起）。大 deck 分多批，按提示传 batch 拿下一批。
看完对存疑页用 view_slide 深查单页全分辨率。`;

const inputSchema = {
  type: 'object',
  properties: {
    batch: { type: 'number', description: '大 deck 分批：第几批（1 起，默认 1）' },
  },
} as const;

export function makeRenderContactSheetTool(): AgentTool {
  return {
    name: 'render_contact_sheet',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema,
    persistPolicy: 'never', // 图走 image content 通道，不进文本落盘
    async execute(input, ctx): Promise<ToolResult> {
      const deckPath = ctx.deckPath;
      if (!deckPath) {
        return { isError: true, text: 'render_contact_sheet: 当前不是 deck 任务（无 deck 路径），此工具不可用。' };
      }
      const batch = typeof (input as { batch?: unknown })?.batch === 'number' ? (input as { batch: number }).batch : 1;
      try {
        const { sheetImages, pageCount } = await buildContactSheet(deckPath, ctx.abortSignal);
        if (sheetImages.length === 0) {
          return { isError: true, text: 'render_contact_sheet: deck 没有可渲染的页（index.html 无 section.slide？）。' };
        }
        const { startSheet, endSheet, totalBatches, batchIndex } = selectSheetBatch(sheetImages.length, batch);
        const picked = sheetImages.slice(startSheet, endSheet);
        const more =
          batchIndex < totalBatches
            ? ` 还有后续批次，看完调 render_contact_sheet(batch=${batchIndex + 1}) 拿下一批。`
            : '';
        return {
          text: `${pageCount} 页联系表（第 ${batchIndex}/${totalBatches} 批，本批 ${picked.length} 张网格图，每格左上角为页码）。${more}`,
          images: picked.map((base64) => ({ base64, mediaType: 'image/png' as const })),
        };
      } catch (e) {
        if (ctx.abortSignal?.aborted) throw e; // 取消时透传，不把"渲染已取消"谎报成渲染失败（设计 §4 abort 纪律）
        return {
          isError: true,
          text: `render_contact_sheet: 渲染失败——${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}
