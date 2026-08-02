/**
 * download_image AgentTool —— 把模型选中那张候选的全分辨率原图下载、校验、落到 deck 的 images/。
 *
 * 两段式的第二段（对齐 web_search→web_fetch）：image_search 返回候选，模型挑一张把其 contentUrl
 * 传进来落地。无状态——直传 contentUrl，不发 id 句柄（同 web_fetch 拿 web_search 的 URL）。
 *
 * 关键约束（决策 5）：
 *  - dest 必须绝对路径 `<deckPath>/images/x.jpg`（相对路径锚不到具体 deck；sandbox 只认绝对）。
 *  - 落盘名权威回传——净化/去重后真实名可能 ≠ 模型预想名，返回真实相对路径让模型据此写 <img src>。
 *  - 文件名去 querystring/fragment，否则绕过缺图扫描。
 */
import { promises as fs } from 'node:fs';
import { dirname, join } from 'node:path';
import { Buffer } from 'node:buffer';
import type { AgentTool, ToolResult } from '@shared/agent/backend';
import { detectMime } from '../../conversations/attachments';
import { consumeBudget, getMaxBudget } from '../../search/budget';
import { safeImageFetch } from '../../search/safeFetch';
import { SsrfBlockedError } from '../../search/ssrf';
import { assertWritableSandbox, SandboxError } from './pathSandbox';
import { finalizeFilename, parseDownloadInput, relImagePath } from './downloadImageInput';
import { stashToolVisual } from './toolVisuals';

const TOOL_DESC = `下载一张图片到 deck 的 images/ 目录，并返回你该写进 <img src> 的相对路径。

配合 image_search 用：先 image_search 看候选 → 挑一张 → download_image(url=该候选的 contentUrl, dest=<deckPath>/images/起个名.jpg)。

**重要**：
- dest 必须是**绝对路径**，形如 \`<deckPath>/images/hero.jpg\`（deckPath 是你正在做的这个 deck 的目录）。相对路径无法定位到 deck。
- 落地后我会返回**真实的相对路径**（重名会自动加后缀，如 images/hero-2.jpg）——请用我返回的这个路径写 <img src>，别用你 dest 里那个，否则可能串名裂图。
- 下不下来（防盗链 403 / 坏链）时换 image_search 候选里的另一张；都不行就换关键词重搜。`;

const DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 20000;
const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

export function makeDownloadImageTool(): AgentTool {
  return {
    name: 'download_image',
    mutatesEnvironment: true,
    description: TOOL_DESC,
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要下载的图片 URL（image_search 候选的 contentUrl）' },
        dest: {
          type: 'string',
          description: '落盘绝对路径，形如 <deckPath>/images/hero.jpg',
        },
      },
      required: ['url', 'dest'],
    },
    persistPolicy: 'never',
    async execute(input, ctx): Promise<ToolResult> {
      const parsed = parseDownloadInput(input);
      if ('error' in parsed) return { isError: true, text: parsed.error };
      const { url, dest } = parsed;

      if (!consumeBudget(ctx.searchBudgetId ?? ctx.conversationId)) {
        return {
          isError: true,
          text: `本轮搜索次数已达硬上限 ${getMaxBudget()}。请先汇总当前发现。`,
        };
      }

      // 写路径沙箱校验（早失败：dest 不在 deck/项目可写根内就别下载了）
      try {
        await assertWritableSandbox(dest, ctx);
      } catch (e) {
        if (e instanceof SandboxError) return { isError: true, text: `download_image: ${e.message}` };
        throw e;
      }

      // 下载：SSRF 逐跳校验（含 redirect 落点）+ 体积上限 + 超时
      let bytes: Uint8Array;
      try {
        const r = await safeImageFetch(url, {
          maxBytes: DOWNLOAD_MAX_BYTES,
          timeoutMs: DOWNLOAD_TIMEOUT_MS,
          signal: ctx.abortSignal,
        });
        bytes = r.bytes;
      } catch (e) {
        if (e instanceof SsrfBlockedError) {
          return { isError: true, text: `download_image: 这个 URL 不安全被拦下（${e.reason}），换一张候选。` };
        }
        return { isError: true, text: formatDownloadFail(url, e) };
      }

      // 校验是真图：直接 magic bytes 定真伪（图床常返回 application/octet-stream，
      // content-type 不可信，故下载路径不预筛 content-type，以字节为准）
      const buf = Buffer.from(bytes);
      const mime = detectMime(buf);
      if (!mime) {
        return {
          isError: true,
          text: `download_image: 这个 URL 返回的不是图片（可能是 HTML 错误页/防盗链）。换 image_search 候选里的另一张。`,
        };
      }

      // 权威落盘名（去 querystring + 净化 + 实测后缀）+ 重名去重
      const baseName = finalizeFilename(dest, MIME_EXT[mime]);
      const targetDir = dirname(dest);
      let finalName = baseName;
      let finalPath = join(targetDir, finalName);
      try {
        await fs.mkdir(targetDir, { recursive: true });
        finalPath = await pickUniqueFile(targetDir, baseName);
        finalName = finalPath.slice(targetDir.length + 1);
        await fs.writeFile(finalPath, buf);
      } catch (e) {
        return { isError: true, text: `download_image: 落盘失败——${(e as Error).message}` };
      }

      const relPath = relImagePath(dest, finalName);
      const sourceHost = hostOf(url);

      // 可见性（决策 8）：落地图 + 相对路径 + 来源
      stashToolVisual(ctx.conversationId, 'download_image', input, {
        kind: 'download_image',
        imgPath: finalPath,
        relPath,
        sourceHost,
      });

      return {
        isError: false,
        text: `已保存（来源 ${sourceHost}，${(buf.length / 1024).toFixed(0)}KB）。用这个相对路径写 src：${relPath}`,
        structured: { relPath, sourceHost, bytes: buf.length },
      };
    },
  };
}

/** 文件级重名去重：x.png 存在则试 x-2.png / x-3.png …，返回可用的绝对路径。 */
async function pickUniqueFile(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let n = 2;
  while (await pathExists(join(dir, candidate))) {
    candidate = `${stem}-${n}${ext}`;
    n += 1;
    if (n > 999) throw new Error(`重名爆表：${name}`);
  }
  return join(dir, candidate);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '?';
  }
}

function formatDownloadFail(url: string, e: unknown): string {
  const msg = (e as Error).message;
  if (msg.includes('HTTP 403') || msg.includes('HTTP 401')) {
    return `download_image: ${hostOf(url)} 拒绝直接下载（防盗链）。换 image_search 候选里的另一张试试。`;
  }
  return `download_image: 这张下不下来（${msg}）。换一张候选，或换关键词重搜。`;
}
