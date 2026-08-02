/**
 * 图片附件的渲染端共享逻辑——聊天（chatStore / ChatInput）与任务评论
 * （taskboardCommentStore / CommentInput）共用，避免两份校验/转换长歪。
 *
 * 职责边界：只做"选图 → 校验 → blob 预览 → 转 ws/乐观形态"这条纯逻辑；
 * 状态归属（按 conv 分桶 / 评论本地 state）留给各自调用方。
 */
import type { ChatAttachment } from '@shared/types';
import type { WireImageAttachment } from '@shared/protocol';
import { fileToBase64 } from './fileToBase64';
import i18n from '@/lib/i18n';

// 单张 ≤ 5 MB、单条 ≤ 8 张、4 种格式——与服务端 saveAttachments 的校验保持一致
export const MAX_BYTES_PER_IMAGE = 5 * 1024 * 1024;
export const MAX_IMAGES_PER_MESSAGE = 8;
export const ALLOWED_IMAGE_MIME = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

/**
 * 渲染端的"待发送图片"形态。file 用于读 base64；displayUrl = createObjectURL(file)
 * 给输入框 strip 即时缩略图（发送后由真实 oru-conv-img:// 替换并 revoke）。
 */
export type PendingAttachment = {
  id: string; // React key
  file: File;
  displayUrl: string;
};

// selector fallback 稳定引用——空 bucket 不每次新建数组，避免无谓重渲染
export const EMPTY_ATTACHMENTS: PendingAttachment[] = [];

/**
 * 校验单批文件的格式与单张大小，并为通过者建 blob URL。
 * 返回 accepted（已建 URL）+ reason（首个不合格原因，null=全过）。
 * 不管"单条总数上限"——那要按调用方各自 prev 算，留给调用方。
 */
export function buildPendingAttachments(files: File[]): {
  accepted: PendingAttachment[];
  reason: string | null;
} {
  for (const f of files) {
    if (!ALLOWED_IMAGE_MIME.has(f.type)) {
      return { accepted: [], reason: i18n.t('common:attachment.rejectFormat', { name: f.name }) };
    }
    if (f.size > MAX_BYTES_PER_IMAGE) {
      return {
        accepted: [],
        reason: i18n.t('common:attachment.rejectSize', { name: f.name, size: (f.size / 1024 / 1024).toFixed(1) }),
      };
    }
  }
  const accepted = files.map((f, i) => ({
    // 同批多文件 Date.now() 相同——拼 index 保证同批内绝对唯一，random 段区分跨批
    id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`,
    file: f,
    displayUrl: URL.createObjectURL(f),
  }));
  return { accepted, reason: null };
}

/**
 * 单条总数上限校验——必须在持有最新 prev 的同步上下文里调（store 的 set 回调 / ref）。
 * 越界时 revoke 这批 accepted 的 blob 并返回本地化原因（随界面语言）；未越界返回 null。
 * chatStore（按 conv 分桶）与评论框（组件本地）共用，保证上限/文案/revoke 行为一致。
 */
export function checkCountLimit(prevCount: number, accepted: PendingAttachment[]): string | null {
  if (prevCount + accepted.length > MAX_IMAGES_PER_MESSAGE) {
    for (const a of accepted) URL.revokeObjectURL(a.displayUrl);
    return i18n.t('common:attachment.countLimit', {
      max: MAX_IMAGES_PER_MESSAGE,
      prev: prevCount,
      cur: accepted.length,
    });
  }
  return null;
}

/** 乐观渲染用：PendingAttachment[] → ChatAttachment[]（relPath 空、blob displayUrl）。 */
export function toOptimisticAttachments(items: PendingAttachment[]): ChatAttachment[] {
  return items.map((p) => ({
    kind: 'image' as const,
    relPath: '',
    mediaType: p.file.type as ChatAttachment['mediaType'],
    bytes: p.file.size,
    filename: p.file.name,
    displayUrl: p.displayUrl,
  }));
}

/** ws 传输用：PendingAttachment[] → base64 数组。 */
export async function toWireAttachments(
  items: PendingAttachment[],
): Promise<WireImageAttachment[]> {
  return Promise.all(
    items.map(async (p) => ({
      base64: await fileToBase64(p.file),
      mediaType: p.file.type as WireImageAttachment['mediaType'],
      filename: p.file.name,
      bytes: p.file.size,
    })),
  );
}

/** revoke 一组附件里的 blob displayUrl（乐观项被真实消息替换 / 移除时清理，oru-conv-img:// 不动）。 */
export function revokeBlobUrls(attachments: ChatAttachment[] | undefined): void {
  if (!attachments) return;
  for (const a of attachments) {
    if (a.displayUrl?.startsWith('blob:')) URL.revokeObjectURL(a.displayUrl);
  }
}
