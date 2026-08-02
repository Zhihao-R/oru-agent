/**
 * render_html AgentTool —— 渲染一段 HTML，把截图作为图像返回给模型"看"。
 *
 * 这一层只管"把入参解析成 RenderRequest、调渲染原语、组装带 image 的 ToolResult"。
 * 真正的渲染在 ../../render/htmlRenderer.ts；图怎么喂回模型在 backends/claudeCode.ts。
 *
 * 校验 / 文案拼装抽成纯函数（parseRenderInput / formatRenderText），单测覆盖，不依赖 Electron。
 */
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { renderHtmlToImage } from '../../render/htmlRenderer';
import { assertReadableSandbox, assertWritableSandbox, SandboxError } from './pathSandbox';
import { formatRenderText, parseRenderInput } from './renderHtmlInput';

const TOOL_DESC = `渲染一段 HTML 并把截图返回给你"看"。写完/改完 HTML 后用它确认视觉效果——是否溢出页框、错位、空白、图片是否正常显示。

**该用**：生成或修改 HTML/deck 后自查；判断版式、排版、是否溢出。
**别用**：只想读 HTML 源码（用 read_file）；想做确定性格式校验（那是校验器的事）。
**截的是一屏**：默认截首屏（一个 viewport）。deck 单页正好一屏。页面比一屏长时，返回会告诉你总高、还剩多少——想看后面就传 scroll_y。`;

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: 'HTML 文件绝对路径（与 html 二选一）' },
    html: { type: 'string', description: '内联 HTML 文本（与 path 二选一）' },
    base_dir: { type: 'string', description: '内联 HTML 的相对资源根目录（用 html 时必填）' },
    scroll_y: {
      type: 'number',
      description: '长页看后续屏：从顶部向下滚动多少像素后截这一屏；默认 0 截首屏',
    },
    viewport_width: { type: 'number', description: '渲染宽度，默认 1920' },
    viewport_height: { type: 'number', description: '渲染高度，默认 1080' },
  },
  // 无 required：path/html 是"二选一"约束，JSON Schema 的 required 表达不了，统一在 parseRenderInput 里校验。
} as const;

export function makeRenderHtmlTool(): AgentTool {
  return {
    name: 'render_html',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema,
    persistPolicy: 'never', // 文字短无需落盘；图走 image content 通道，不进 .tool-cache 文本落盘
    async execute(input, ctx): Promise<ToolResult> {
      const parsed = parseRenderInput(input);
      if ('error' in parsed) return { isError: true, text: parsed.error };
      const { req } = parsed;

      // 路径沙箱校验：file 走可读沙箱（防越权截系统文件）；inline 的 baseDir 走可写沙箱（要往里写临时文件）
      try {
        if (req.source.kind === 'file') {
          await assertReadableSandbox(req.source.path, ctx);
        } else {
          await assertWritableSandbox(req.source.baseDir, ctx);
        }
      } catch (e) {
        if (e instanceof SandboxError) return { isError: true, text: `render_html: ${e.message}` };
        throw e;
      }

      try {
        const { pngBase64, meta } = await renderHtmlToImage({ ...req, signal: ctx.abortSignal });
        return {
          text: formatRenderText({ ...meta, scrollY: req.scrollY ?? 0 }),
          images: [{ base64: pngBase64, mediaType: 'image/png' }],
        };
      } catch (e) {
        // RenderError 与其它异常都带可读 message（RenderError extends Error），一支足矣
        return {
          isError: true,
          text: `render_html: 渲染失败——${e instanceof Error ? e.message : String(e)}`,
        };
      }
    },
  };
}
