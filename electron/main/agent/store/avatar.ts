/**
 * 头像（agent / user）上传：把前端裁剪后的 PNG（base64）写入用户数据目录
 *
 * Agent 头像和 User 头像走同一个目录、不同文件名：
 *   ~/.oru/users/<ownerId>/avatars/twin-<agentId>-<ts>.png    ← agent
 *   ~/.oru/users/<ownerId>/avatars/user-<ts>.png              ← user
 *
 * 共用逻辑（base64 校验 → buffer → PNG magic 校验 → 落盘）抽成 writeAvatarFile
 * helper，agent / user 各调一次。
 *
 * TODO: 失败回滚 + 孤儿清理 — 当前 agent / user 上传后旧文件都成孤儿（每次新文件名
 *       带 timestamp）。未来加 GC sweep 任务扫 avatars 里既不被 agent.avatarPath
 *       也不被 profile.avatarPath 引用的文件，agent / user 走同一份扫描。
 */
import { promises as fs } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { avatarsDir } from '../../runtime/paths';

/** 后端硬上限：base64 字符串最多 8MB（≈ 6MB binary，给前端 5MB cap 留余量） */
const MAX_BASE64_LENGTH = 8 * 1024 * 1024;

/** PNG 文件头 magic bytes — 用于 validate Buffer.from 解出来确实是 PNG */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class AvatarUploadError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = 'AvatarUploadError';
  }
}

/** 共用：base64 → 校验 → 写盘到 avatars 目录的指定文件名 */
async function writeAvatarFile(
  ownerId: string,
  fileName: string,
  base64Png: string,
): Promise<string> {
  if (!base64Png) {
    throw new AvatarUploadError('AVATAR_EMPTY', 'base64Png is empty');
  }
  if (base64Png.length > MAX_BASE64_LENGTH) {
    throw new AvatarUploadError(
      'AVATAR_TOO_LARGE',
      `base64Png exceeds ${MAX_BASE64_LENGTH} chars`,
    );
  }
  const buffer = Buffer.from(base64Png, 'base64');
  if (
    buffer.length < PNG_MAGIC.length ||
    !buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)
  ) {
    throw new AvatarUploadError('AVATAR_NOT_PNG', 'decoded data is not a valid PNG');
  }
  const dir = avatarsDir(ownerId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = join(dir, fileName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/** Agent（Twin）头像。文件名带 timestamp 用于缓存失效；旧文件孤儿等 GC 处理 */
export async function saveAgentAvatar(
  ownerId: string,
  agentId: string,
  base64Png: string,
): Promise<string> {
  const ts = Date.now();
  return await writeAvatarFile(ownerId, `twin-${agentId}-${ts}.png`, base64Png);
}

/** User 头像。文件名带 timestamp 用于缓存失效；旧文件孤儿等 GC 处理（与 agent 一致） */
export async function saveUserAvatar(
  ownerId: string,
  base64Png: string,
): Promise<string> {
  const ts = Date.now();
  return await writeAvatarFile(ownerId, `user-${ts}.png`, base64Png);
}
