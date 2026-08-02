/**
 * v0.3 聊天图片附件——把 chat.send 携带的 base64 图片落盘到对话目录
 *
 * 路径布局：
 *   ~/.oru/users/<ownerId>/conversations/<agentId>/<convId>-images/<msgId>-<n>.<ext>
 *
 * 校验链：
 *   - 数量 ≤ 8（PRD §限制与提示）
 *   - 每张 mediaType 必须在白名单
 *   - magic bytes 与声明的 mediaType 匹配（防伪造）
 *   - 超模型限制（长边或字节）→ 缩放 + JPEG 重编码压到限制内（S34 · G25，撤原「>5MB 直接拒收」）
 *
 * 失败时抛带 code 的 AttachmentError，由 router 翻译成对应 ErrorCode 回执。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { Buffer } from 'node:buffer';
import type { ChatAttachment } from '@shared/types';
import { ErrorCodes } from '@shared/types';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { conversationImagesDir, convDir } from '../runtime/paths';
import { ensureWithinRoot } from '../fs/frontmatter';
import { compressImagesToLimit } from '../render/imageDecoder';

/**
 * 单图模型字节上限——超此值不再拒收，而是缩放 + JPEG 重编码压到此值以内（G25）。
 * 5 MB 是各家视觉模型普遍的单图请求上限（Anthropic 即此），压到线内即可随消息注入。
 */
export const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024; // 5 MB binary
/**
 * 压缩后归一的长边像素上限——各家视觉模型最优分辨率不一，取一个够用的通用上限（同 readFile 读图），
 * 大过它纯耗 token、模型自己也会降采样。压缩只按比例缩、不放大。
 */
export const MAX_IMAGE_LONG_EDGE = 1568;
/**
 * 平台入站图（feishu/discord）下载时的 DoS 天花板——流式读到此值即弃（不截断保存半张）。
 * 与 MAX_BYTES_PER_IMAGE 分开：模型上限是「压到多小」，这条是「下载多大就不值得费带宽」。
 * 放宽到远高于模型上限，好让 5–30 MB 的真实手机照片能落到 saveAttachments 里被压缩，而非下载即拒。
 */
export const MAX_INBOUND_IMAGE_BYTES = 30 * 1024 * 1024; // 30 MB binary
/** 单条消息图片张数上限。导出供平台入站图下载前预检——注定被拒的批次不发生下载 IO。 */
export const MAX_IMAGES_PER_MESSAGE = 8;

const ALLOWED_MIME = new Set<ChatAttachment['mediaType']>([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

/** MIME → 扩展名的单一映射。导出供平台入站图起展示文件名——与落盘扩展名同源，不出现 .jpeg/.jpg 岔开。 */
export const MIME_TO_EXT: Record<ChatAttachment['mediaType'], string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * 各 MIME 的 magic bytes（前 N 字节）。WEBP 比较特殊：'RIFF' + 4 字节大小 + 'WEBP'。
 *
 * 导出供 download_image 复用——它要校验下载的字节"是真图"（决策 5 step4），
 * 正好覆盖 PNG/JPEG/GIF/WebP 四类，无需在那边重写一份 magic-byte 检测。
 */
export function detectMime(buf: Buffer): ChatAttachment['mediaType'] | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    // GIF87a / GIF89a
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export class AttachmentError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AttachmentError';
  }
}

export type IncomingAttachment = {
  base64: string;
  mediaType: ChatAttachment['mediaType'];
  filename: string;
  bytes: number;
};

/** 校验 + 压缩后的待写盘形态。写盘目录 / relPath 由各 save* 调用方决定。 */
export type PreparedAttachment = {
  buffer: Buffer;
  mediaType: ChatAttachment['mediaType'];
  filename: string;
  bytes: number;
};

/**
 * 校验 + 压缩一组入站图（不写盘）——数量 / 格式 / magic-byte / 超限压缩这条纯逻辑收口在此，
 * conv 图与任务图共用一套（imageAttachments.ts 那条注释同理：别让两份校验长歪）。
 * 任一失败抛 AttachmentError（发生在写盘前，无半写）。
 */
export async function prepareAttachments(
  items: IncomingAttachment[],
): Promise<PreparedAttachment[]> {
  if (items.length === 0) return [];
  if (items.length > MAX_IMAGES_PER_MESSAGE) {
    throw new AttachmentError(
      ErrorCodes.ATTACHMENT_TOO_MANY,
      `单条最多 ${MAX_IMAGES_PER_MESSAGE} 张图，本次 ${items.length} 张`,
    );
  }

  const prepared: PreparedAttachment[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const a = items[i];
    if (!ALLOWED_MIME.has(a.mediaType)) {
      throw new AttachmentError(
        ErrorCodes.ATTACHMENT_BAD_FORMAT,
        `第 ${i + 1} 张：不支持的格式 ${a.mediaType}`,
      );
    }
    let buffer: Buffer;
    try {
      buffer = Buffer.from(a.base64, 'base64');
    } catch {
      throw new AttachmentError(
        ErrorCodes.ATTACHMENT_DECODE_FAIL,
        `第 ${i + 1} 张：base64 解码失败`,
      );
    }
    if (buffer.length === 0) {
      throw new AttachmentError(
        ErrorCodes.ATTACHMENT_DECODE_FAIL,
        `第 ${i + 1} 张：解码后为空`,
      );
    }
    const detected = detectMime(buffer);
    if (detected !== a.mediaType) {
      throw new AttachmentError(
        ErrorCodes.ATTACHMENT_DECODE_FAIL,
        `第 ${i + 1} 张：声明 ${a.mediaType} 但实际为 ${detected ?? '未知'}`,
      );
    }
    prepared.push({ buffer, mediaType: a.mediaType, filename: a.filename, bytes: buffer.length });
  }

  // 压缩超限图（G25）：撤「>5MB 直接拒收」，改缩放 + JPEG 重编码压到模型限制内。只碰超字节的那几张，
  // 其余原样保真（不无谓重编码有损）。压缩产物统一 image/jpeg。压不动（坏图 / 离屏失败）才回落拒收。
  // 注：超限的动画 GIF 会被离屏 canvas 压成单帧——模型本就按帧看图、看不到动画，可接受（罕见边缘）。
  const overIdx = prepared.flatMap((p, i) => (p.bytes > MAX_BYTES_PER_IMAGE ? [i] : []));
  if (overIdx.length > 0) {
    const compressed = await compressImagesToLimit(
      overIdx.map((i) => ({ bytes: prepared[i].buffer, mime: prepared[i].mediaType })),
      MAX_IMAGE_LONG_EDGE,
      MAX_BYTES_PER_IMAGE,
    );
    overIdx.forEach((idx, k) => {
      const c = compressed[k];
      if (!c) {
        throw new AttachmentError(
          ErrorCodes.ATTACHMENT_TOO_LARGE,
          `第 ${idx + 1} 张：${(prepared[idx].bytes / 1024 / 1024).toFixed(1)} MB 超限且压缩失败（可能已损坏）`,
        );
      }
      prepared[idx] = {
        buffer: c.bytes,
        mediaType: 'image/jpeg',
        filename: prepared[idx].filename,
        bytes: c.bytes.length,
      };
    });
  }
  return prepared;
}

/**
 * 校验 + 落盘一组图片附件，返回可挂到 ChatMessage.attachments 的形态。
 * 任一失败：抛 AttachmentError（前面已经写盘的不回滚——失败发生在校验阶段，写盘前；后续若加复杂度再做事务）。
 */
export async function saveAttachments(
  agentId: string,
  convId: string,
  msgId: string,
  items: IncomingAttachment[],
): Promise<ChatAttachment[]> {
  const prepared = await prepareAttachments(items);
  if (prepared.length === 0) return [];

  const ownerId = getCurrentOwnerId();
  const dir = conversationImagesDir(ownerId, agentId, convId);
  await fs.mkdir(dir, { recursive: true });

  const out: ChatAttachment[] = [];
  for (let i = 0; i < prepared.length; i += 1) {
    const p = prepared[i];
    const ext = MIME_TO_EXT[p.mediaType];
    const seq = i + 1;
    const fileName = `${msgId}-${seq}.${ext}`;
    await fs.writeFile(join(dir, fileName), p.buffer);
    out.push({
      kind: 'image',
      relPath: `${convId}-images/${fileName}`,
      mediaType: p.mediaType,
      bytes: p.bytes,
      filename: p.filename,
    });
  }
  return out;
}

/**
 * 删 conversation 时调，rm -rf 整个 images 目录（不存在时静默通过）
 */
export async function deleteConversationImages(
  agentId: string,
  convId: string,
): Promise<void> {
  const ownerId = getCurrentOwnerId();
  const dir = conversationImagesDir(ownerId, agentId, convId);
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * 取 conversation jsonl 所在的 agent 根目录——relPath 都相对它解析。
 * 路径沙箱根：保证 relPath 不能越出此目录。
 */
function agentDir(ownerId: string, agentId: string): string {
  return join(convDir(ownerId), agentId);
}

/**
 * 读取已落盘附件为 base64（供 historyAdapter 重发历史给 backend）。
 * 用 ensureWithinRoot 防御 relPath 路径遍历——理论上 saveAttachments 生成的 relPath
 * 都在 `<convId>-images/` 之下，但走读盘流程前再校验一次，避免 jsonl 落盘数据
 * 被外部修改后造成任意文件读取。
 */
export async function readAttachmentBase64(
  agentId: string,
  convId: string,
  attachment: ChatAttachment,
): Promise<string> {
  const buf = await fs.readFile(attachmentAbsPath(agentId, attachment));
  return buf.toString('base64');
}

/**
 * 附件在磁盘上的绝对路径。与 readAttachmentBase64 同一套解析与防御，供需要"指路"而非
 * "读内容"的调用方用——claude-code 灌历史时把老图的占位句改成这个路径，模型要看就 read_file。
 */
export function attachmentAbsPath(agentId: string, attachment: ChatAttachment): string {
  // 防御 relPath='' 或 falsy——前端乐观消息可能填空串，正常路径不应走到此函数；
  // 但若意外触发，ensureWithinRoot('') 会解析为 root 目录本身，fs.readFile 在目录上抛 EISDIR
  if (!attachment.relPath || attachment.relPath.trim() === '') {
    throw new Error('attachment.relPath is empty (cannot read)');
  }
  const root = agentDir(getCurrentOwnerId(), agentId);
  return ensureWithinRoot(root, attachment.relPath);
}

/**
 * 给 ChatMessage 的 attachments 填上渲染端可用的 oru-conv-img:// URL
 * （file:// 会被主窗口 webSecurity 拦下，自定义协议见 imageProtocol.ts）。
 * 落盘的 jsonl 不带 displayUrl；conv.history.result 出口处 hydrate 一次。
 *
 * 同样用 ensureWithinRoot 防御 relPath 越界——确保渲染端拿到的 URL
 * 不可能指向 conversations/<agentId>/ 之外的文件。
 */
export function hydrateAttachmentDisplayUrls(
  msg: { attachments?: ChatAttachment[] } & Record<string, unknown>,
  agentId: string,
): typeof msg {
  if (!msg.attachments || msg.attachments.length === 0) return msg;
  const ownerId = getCurrentOwnerId();
  const root = agentDir(ownerId, agentId);
  return {
    ...msg,
    attachments: msg.attachments.map((a) => {
      // relPath 空：肯定是乐观消息或脏数据，UI 显示文件名占位即可
      if (!a.relPath || a.relPath.trim() === '') {
        return { ...a, displayUrl: undefined };
      }
      let abs: string;
      try {
        abs = ensureWithinRoot(root, a.relPath);
      } catch {
        // 越界：跳过 displayUrl，UI 会显示文件名占位（没法看图但不阻断）
        return { ...a, displayUrl: undefined };
      }
      // encodeURI 处理路径里的空格等字符；host 'local' 占位（见 imageProtocol.ts 文件头）
      return { ...a, displayUrl: `oru-conv-img://local${encodeURI(abs)}` };
    }),
  };
}
