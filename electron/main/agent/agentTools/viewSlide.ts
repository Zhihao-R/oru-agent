/**
 * view_slide AgentTool —— 深查 deck 单页全分辨率（联系表上看不清的存疑页看清晰版）。
 *
 * 复用 contactSheet 的单页渲染（renderSinglePage，与联系表同一条渲染路径，fresh 重渲反映
 * 当前 index.html）。deck 路径自 toolContext.deckPath；page 1 起对齐联系表页码徽标。
 */
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { renderSinglePage } from '../../deck/contactSheet';

const TOOL_DESC = `渲染 deck 的某一页全分辨率给你"看"清晰版。
**该用**：在联系表里看到某页存疑（太挤/错位/配图不搭），深查这一页的细节。
**入参**：page —— 第几页（1 起，与联系表页码一致）。`;

const inputSchema = {
  type: 'object',
  properties: {
    page: { type: 'number', description: '第几页（1 起）' },
  },
  required: ['page'],
} as const;

export function makeViewSlideTool(): AgentTool {
  return {
    name: 'view_slide',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema,
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const deckPath = ctx.deckPath;
      if (!deckPath) {
        return { isError: true, text: 'view_slide: 当前不是 deck 任务（无 deck 路径），此工具不可用。' };
      }
      const page = (input as { page?: unknown })?.page;
      if (typeof page !== 'number' || !Number.isFinite(page) || page < 1) {
        return { isError: true, text: 'view_slide: page 必须是 ≥1 的整数（第几页，1 起）。' };
      }
      try {
        const { base64, canvas } = await renderSinglePage(deckPath, Math.floor(page) - 1, ctx.abortSignal);
        return {
          text: `第 ${Math.floor(page)} 页全分辨率（${canvas.width}×${canvas.height}）。`,
          images: [{ base64, mediaType: 'image/png' }],
        };
      } catch (e) {
        if (ctx.abortSignal?.aborted) throw e; // 取消时透传，不谎报渲染失败（设计 §4 abort 纪律）
        return {
          isError: true,
          text: `view_slide: 渲染失败——${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}
