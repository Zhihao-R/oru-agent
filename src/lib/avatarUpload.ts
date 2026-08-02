/**
 * 头像上传 helper（agent / user 共享文件大小 + MIME 校验和 blob → base64 转换）
 *
 * - validateAvatarFile：本地校验文件类型 + 大小
 * - blobToBase64：blob → base64（不带 data: 前缀），分块避免 stack overflow
 * - uploadAgentAvatar：上传 agent（Twin）头像，返回持久化路径
 * - User 头像不在这里上传——通过 userProfileStore.update 跟 name 一起原子提交
 */
import { wsClient } from './ws';
import i18n from '@/lib/i18n';

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];

export class AvatarValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AvatarValidationError';
  }
}

export function validateAvatarFile(file: File): void {
  if (!ALLOWED_MIME.includes(file.type)) {
    throw new AvatarValidationError(i18n.t('profile:avatarBadFormat', { type: file.type }));
  }
  if (file.size > MAX_BYTES) {
    throw new AvatarValidationError(i18n.t('profile:avatarTooLarge'));
  }
}

/** blob → base64（不带 data: 前缀），分块避免 stack overflow */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export async function uploadAgentAvatar(
  agentId: string,
  pngBlob: Blob,
): Promise<string> {
  const base64Png = await blobToBase64(pngBlob);
  const res = await wsClient.request({
    type: 'agents.avatar.upload',
    agentId,
    base64Png,
  });
  if (res.type !== 'agents.avatar.upload.result') {
    // onSave catch 直接 setError(err.message) 展示给用户（类①）——翻译；协议类型 res.type 是诊断数据，原样插值
    throw new Error(i18n.t('profile:avatarUploadFailed', { type: res.type }));
  }
  return res.path;
}
