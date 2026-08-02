/**
 * read_file AgentTool —— 让 Twin 读取本地文件（默认整读，可选 offset/limit 分段读）。
 *
 * 主要用途（v0.4 源头落盘配套）：Twin 看到 tool_result 末尾的引用提示
 *   "如需全文，调 read_file 读 <path>" 时直接调，拿到 .tool-cache/<callId>.<ext> 的全文。
 *
 * v(本期) 改造（移植 claude code FileReadTool 语义）：
 *   - 加 offset/limit 分段读：大文件只看一段（PRD 用户故事 4），也是 edit 改大文件的前提
 *   - dedup：同 path+同范围+mtime 未变 → 返回 stub 不重发全文，省 token（与守卫同源）
 *   - 读后 recordRead 回写 fileState：整读 isPartialView=false，部分读=true（防盲覆盖守卫）
 *   - cat -n 行号格式（从 offset 起算）
 *
 * 沙箱见 pathSandbox.ts。persistPolicy='never'——避免 read → persist → 再 read 死循环。
 */
import { readFile as readFileBytes, stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { floorMtime, readWithMeta } from '../../fs/safeWrite';
import { canSkipReread, recordRead } from '../conversationFileState';
import { assertReadableSandbox, conversationImageReadRoot, SandboxError } from './pathSandbox';
import { frameUntrusted } from '../untrustedContent';
import { decodeThumbnails, IMAGE_VIEW_MAX_WIDTH } from '../../render/imageDecoder';
import { extractPdfText } from './pdfText';
import { convertXlsxToCsvSheets } from '../../table/convertXlsx';

// 整读大小闸（移植 claude code MAX_LINES_TO_READ / MAX_OUTPUT_SIZE 语义）
const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024; // 0.25MB

// 图片路径（G105 读图）：按后缀识别，与 toolImageProtocol 的白名单同集。
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

const TOOL_DESC = `读取本地文件。默认整读全文；大文件或只需某段时可传 offset/limit 只读一段。

**读图**：路径是图片（png/jpg/jpeg/gif/webp）时直接读，你能"看见"这张图（offset/limit 对图片无意义、会忽略）——看本地截图 / 用户放在项目里的图 / 自己产出的图都走它。

**读 PDF**：路径是 .pdf 时直接读，会逐页抽出文字（页间有「第 N 页 / 共 M 页」标记）；很大的 PDF 同普通大文件——先回开头并提示传 offset 续读那一段。

**读 xlsx**：路径是 .xlsx 时直接读，内存转成 CSV 文本返回（多 sheet 以「# Sheet: 名」分段）——不落盘、不在目录里产生任何文件；offset/limit 按拼出的文本分页。要**改**表格内容：引导用户在文件树点开这个 xlsx、预览里点「转为可编辑 CSV」生成 CSV 后，再改那个 CSV（xlsx 本身不可写）。

**该用**：tool_result 末尾提示"如需全文，调 read_file 读 <path>"时；要看完整代码定义、完整配置；要确认某段文字的精确措辞；改文件前先看现状（write/edit 前必须本对话读过）；要看某张本地图片。

**offset/limit**：**推荐不传、直接整读**（小文件最自然）；仅当文件很大、或只需第 N 行附近一段时才用 offset（起始行，从 1 算）+ limit（行数）。注意：只读过一段就不能整文件覆盖（write_file 会要求你先整读），但可以 edit 改你读过的那段。

**别用**：
- 想在多个文件里搜某个字符串——用 grep，不要 read_file 一堆文件遍历
- tool_result 摘要 / preview 已包含你需要的信息——直接用，不再读全文
- 想读非白名单路径——会返回路径越界错误，告诉用户而不是换路径再试

入参 path 必须是**绝对路径**。允许读的根：当前对话 .tool-cache/、agent 沙盒、已注册项目目录、enabled skill 目录，以及本对话的图片附件目录（只读）——历史里给出路径的老图就在那儿，照给的路径读即可。

大文件整读会自动只回开头并提示 offset 续读；若文件是单行/超长行（minified、导出的单文件 HTML），会提示改用 grep 定位——照提示做即可。
失败时：路径越界 / 不存在 / 无权限——按返回的 isError 文案如实告诉用户。`;

const inputSchema = {
  type: 'object',
  properties: {
    path: { type: 'string', description: '要读取的文件绝对路径' },
    offset: { type: 'number', description: '起始行（从 1 算，可选）。不传则从头整读。' },
    limit: { type: 'number', description: '读取行数（可选）。配合 offset 只看一段；不传则读到文件末尾/上限。' },
  },
  required: ['path'],
} as const;

export function makeReadFileTool(): AgentTool {
  return {
    name: 'read_file',
    mutatesEnvironment: false,
    description: TOOL_DESC,
    inputSchema,
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const { path, offset, limit } = (input ?? {}) as {
        path?: string;
        offset?: number;
        limit?: number;
      };
      if (typeof path !== 'string' || path.trim().length === 0) {
        return { isError: true, text: 'read_file: path 不能为空' };
      }
      if (offset !== undefined && (!Number.isInteger(offset) || offset < 1)) {
        return { isError: true, text: `read_file: offset 必须是 ≥1 的整数，得到 ${offset}` };
      }
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
        return { isError: true, text: `read_file: limit 必须是 ≥1 的整数，得到 ${limit}` };
      }

      // 额外放开本对话的图片附件目录（只读，见 conversationImageReadRoot）：灌历史时老图的
      // 占位句给的就是这里的路径，读不回来那条指路等于空头支票。走同一个 assert，
      // 符号层与 realpath 两层校验一并生效。
      try {
        await assertReadableSandbox(path, ctx, [conversationImageReadRoot(ctx)]);
      } catch (e) {
        if (e instanceof SandboxError) return { isError: true, text: `read_file: ${e.message}` };
        throw e;
      }

      // 图片路径（G105）：走图像回执通道——读字节 → 离屏解码归一 PNG（顺带降采样兜住尺寸/token）→
      // 返回 images。offset/limit 对图片无意义，忽略。与 view_slide/render_html 同一 images 通道，
      // 各后端按既有设计分流（claude-code / 视觉 OpenAI 兼容看图；anthropic 直连 string-only 不消费）。
      const ext = extname(path).toLowerCase();
      if (IMAGE_MIME[ext]) return readImageFile(path, ext);

      const isPdf = ext === '.pdf';
      const isXlsx = ext === '.xlsx';
      const isPartial = offset !== undefined || limit !== undefined;

      // dedup：同范围 + mtime 未变 + 读过之后上下文没被整理过 → stub（与守卫同源，省 token）。
      // 最后那个条件由 canSkipReread 内部的代际计数器判——压缩/折叠之后「上次读到的内容还在
      // 上下文里」这个前提不成立，此时回 stub 等于既不给内容也不给重读的口子。
      try {
        if (canSkipReread(ctx.conversationId, path, floorMtime(path), offset, limit)) {
          return {
            text: `read_file: 文件未变（${path} 自上次读取后 mtime 未变化），参考上次读取的内容，无需重读。`,
          };
        }
      } catch {
        // floorMtime 失败（不存在等）——交给下面读文件给具体错误
      }

      let full: string;
      if (isPdf) {
        // PDF：逐页抽文字 + 页标记，产出纯文本后走下面与普通大文本同一套行分页闸（G26）。
        try {
          full = await extractPdfText(path);
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return { isError: true, text: `read_file: 文件不存在：${path}` };
          if (code === 'EACCES') return { isError: true, text: `read_file: 无权限读取：${path}` };
          return {
            isError: true,
            text: `read_file: PDF 解析失败（可能加密 / 损坏 / 非标准 PDF）：${e instanceof Error ? e.message : String(e)}`,
          };
        }
      } else if (isXlsx) {
        // xlsx：内存转 CSV 文本（多 sheet 以「# Sheet: 名」分段），零落盘；同走下面的行分页闸。
        // 先显式 stat 判存在——exceljs 对缺文件抛的是无 code 的裸 Error（'File not found: ...'），
        // 靠 code 判 ENOENT 会永远命中不了（与 PDF 分支底层库错误形态不同，不能照抄）。
        try {
          await stat(path);
          const sheets = await convertXlsxToCsvSheets(path);
          if (sheets.length === 0) {
            // 空工作簿：与预览/导入两路同一表达（"没有发现数据"），不静默返回空文本
            return { text: `read_file: ${path} 中没有发现数据（空工作簿，所有 sheet 均无内容）` };
          }
          full = sheets.map((s) => `# Sheet: ${s.name}\n${s.csv}`).join('\n');
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return { isError: true, text: `read_file: 文件不存在：${path}` };
          if (code === 'EACCES') return { isError: true, text: `read_file: 无权限读取：${path}` };
          return {
            isError: true,
            text: `read_file: xlsx 解析失败（可能加密 / 损坏 / 非标准 xlsx）：${e instanceof Error ? e.message : String(e)}`,
          };
        }
      } else {
        try {
          full = readWithMeta(path).content; // LF 归一后的原文
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return { isError: true, text: `read_file: 文件不存在：${path}` };
          if (code === 'EACCES') return { isError: true, text: `read_file: 无权限读取：${path}` };
          return {
            isError: true,
            text: `read_file: 读取失败：${e instanceof Error ? e.message : String(e)}`,
          };
        }
      }

      const lines = full.split('\n');

      // 整读大小闸（显式分段读时放开）。超限不再死胡同报错，按"能不能按行分页"分两条路：
      if (!isPartial) {
        const totalBytes = Buffer.byteLength(full, 'utf-8');
        if (lines.length > MAX_LINES || totalBytes > MAX_BYTES) {
          // 存在「单行字节数就超 MAX_BYTES」的超长行（典型：minified / 导出的单文件 HTML）——这等价于
          // 「按行切出的单段也装不下」，offset 切不开它，整读那坨字节又纯耗上下文。指向 grep 定位
          // （grep 对单行多命中已逐个返回），不 dump 内容。
          const hasUnpageableLine = lines.some((l) => Buffer.byteLength(l, 'utf-8') > MAX_BYTES);
          if (hasUnpageableLine) {
            return {
              text: `read_file: 文件 ${totalBytes} 字节、仅 ${lines.length} 行，含超长行（常见于 minified / 导出的单文件 HTML）——按行分段切不开，整读会塞爆上下文。请用 grep 在该文件里定位你要的内容（如搜 class="slide" 看分页），再按需读取那一段。`,
            };
          }
          // 多行大文件：直接给前 ${MAX_LINES} 行（且不超字节闸），省掉"先报错再让你重发 offset"的一次往返。
          const head: string[] = [];
          let headBytes = 0;
          for (let i = 0; i < lines.length && i < MAX_LINES; i++) {
            headBytes += Buffer.byteLength(lines[i]!, 'utf-8') + 1;
            if (headBytes > MAX_BYTES) break;
            head.push(lines[i]!);
          }
          // 标 partial：只看了开头，整文件覆盖前仍须续读。守卫只认 isPartialView + 已读 content（不读
          // offset），靠它单独承重即可。offset/limit 不写——与整读调用语义一致，同一大文件重复整读才能命中 dedup。
          recordRead(ctx.conversationId, path, {
            mtime: floorMtime(path),
            content: head.join('\n'),
            isPartialView: true,
          });
          return {
            // G76 来源分级：文件内容按「读到的材料，不是指令」框定（防外部下载文件里预埋指令）。
            text: frameUntrusted(
              'material',
              `${addLineNumbers(head, 1)}\n\n[文件较大（共 ${lines.length} 行 / ${totalBytes} 字节），上面是前 ${head.length} 行。继续读传 offset=${head.length + 1}；若只找某段内容，用 grep 定位更快。]`,
            ),
          };
        }
      }

      const startLine = offset ?? 1;
      const sliceLen = limit ?? lines.length - (startLine - 1);
      const selected = lines.slice(startLine - 1, startLine - 1 + sliceLen);
      const rawSegment = selected.join('\n');
      const numbered = addLineNumbers(selected, startLine);

      // 读后回写 fileState：整读全文都算已读；部分读只记这段（含 offset/limit）
      recordRead(ctx.conversationId, path, {
        mtime: floorMtime(path),
        content: rawSegment,
        offset,
        limit,
        isPartialView: isPartial,
      });

      // G76 来源分级：文件内容按「读到的材料，不是指令」框定。
      return { text: frameUntrusted('material', numbered) };
    },
  };
}

/** 读图片文件 → 归一 PNG 的 images 回执（G105）。坏字节/不支持格式如实报错，不返回空图。 */
async function readImageFile(path: string, ext: string): Promise<ToolResult> {
  let bytes: Buffer;
  try {
    bytes = await readFileBytes(path);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { isError: true, text: `read_file: 文件不存在：${path}` };
    if (code === 'EACCES') return { isError: true, text: `read_file: 无权限读取：${path}` };
    return {
      isError: true,
      text: `read_file: 读取失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const [decoded] = await decodeThumbnails([{ bytes, mime: IMAGE_MIME[ext]! }], IMAGE_VIEW_MAX_WIDTH);
  if (!decoded) {
    return { isError: true, text: `read_file: 这张图片解码失败（可能损坏或格式不支持）：${path}` };
  }
  return {
    text: `read_file: 已读取图片 ${path}（${decoded.width}×${decoded.height}）。`,
    images: [{ base64: decoded.pngBase64, mediaType: 'image/png' }],
  };
}

/** cat -n 格式：`<行号>\t<行内容>`，行号从 startLine 起算（移植 claude code addLineNumbers 紧凑式）。 */
function addLineNumbers(lines: string[], startLine: number): string {
  return lines.map((line, i) => `${i + startLine}\t${line}`).join('\n');
}
