/**
 * 用户自己的 profile（名字 + 头像）store
 *
 * 跟 Agent 严格分开：Agent 是 Twin 那边（系统配置 / 角色升级写入），
 * UserProfile 是用户对自己的表达（用户改自己）。两者写入权限来源不同，
 * 不该共享一个写入入口。
 *
 * 落盘位置：~/.oru/users/<ownerId>/profile.json
 * 不存在时调 bootstrapDefaults 用 OS username 兜底（user 首次进主页应当 hover
 * 编辑改成想要的称呼；OS username 只是占位）。
 *
 * 模式与 electron/main/agent/store/agents.ts 对齐：load → cache 单例；corrupt → 内存默认 +
 * cache.set（不写盘，跟 agents 一致避免在 corrupt 时反复触发副作用）。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import os from 'node:os';
import { ErrorCodes, type UserProfile } from '@shared/types';
import { avatarsDir, profilePath } from '../runtime/paths';
import { safeWriteAsync } from '../fs/safeWrite';

const cache: Map<string, UserProfile> = new Map();

const NAME_MIN = 1;
const NAME_MAX = 20;

export class ProfileValidationError extends Error {
  /** 固定为 ErrorCodes.PROFILE_INVALID — router 据此映射 ErrorEvent */
  public readonly code = ErrorCodes.PROFILE_INVALID;

  constructor(message: string) {
    super(message);
    this.name = 'ProfileValidationError';
  }
}

function defaultProfile(ownerId: string): UserProfile {
  // OS username 作为占位（用户首次进主页应当 hover 编辑改成想要的称呼）
  const name = (os.userInfo().username || 'You').trim().slice(0, NAME_MAX) || 'You';
  return { ownerId, name, avatarPath: null };
}

function rehydrate(p: Partial<UserProfile>, ownerId: string): UserProfile {
  return {
    ownerId,
    name: p.name ?? defaultProfile(ownerId).name,
    avatarPath: p.avatarPath ?? null,
  };
}

async function persist(ownerId: string, profile: UserProfile): Promise<void> {
  // 原子写内核自带 mkdir -p 父目录（= userDir），无需再手动建目录
  await safeWriteAsync(profilePath(ownerId), JSON.stringify(profile, null, 2));
}

/**
 * 首次启动 / 文件不存在：写入默认 profile 到盘。
 * corrupt 文件：仅返回内存默认（不重写盘，让用户能手动修复 / 备份）。
 */
async function load(ownerId: string): Promise<UserProfile> {
  const cached = cache.get(ownerId);
  if (cached) return cached;

  const path = profilePath(ownerId);
  if (!existsSync(path)) {
    const profile = defaultProfile(ownerId);
    await persist(ownerId, profile);
    cache.set(ownerId, profile);
    return profile;
  }
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<UserProfile>;
    const profile = rehydrate(parsed, ownerId);
    cache.set(ownerId, profile);
    return profile;
  } catch {
    // corrupt：用内存默认（不写盘覆盖损坏文件，用户可能想手动修复）
    const profile = defaultProfile(ownerId);
    cache.set(ownerId, profile);
    return profile;
  }
}

/** 校验 name —— 提取出来供 router 在写图前调用，避免"图写入成功但 name 失败"留孤儿 */
export function validateName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length < NAME_MIN) {
    throw new ProfileValidationError('名字不能为空');
  }
  if (trimmed.length > NAME_MAX) {
    throw new ProfileValidationError(`名字最多 ${NAME_MAX} 字`);
  }
  return trimmed;
}

/** 校验 avatarPath：要么是 null，要么必须落在 <userData>/avatars/ 下（防外部路径注入） */
function validateAvatarPath(path: string | null, ownerId: string): string | null {
  if (path === null) return null;
  const base = avatarsDir(ownerId);
  // 用前缀匹配 + 路径分隔符确保是子路径而不是同前缀的姊妹目录
  if (!path.startsWith(base + '/') && path !== base) {
    throw new ProfileValidationError('avatarPath 超出允许范围');
  }
  return path;
}

export async function getProfile(ownerId: string): Promise<UserProfile> {
  return await load(ownerId);
}

export async function updateProfile(
  ownerId: string,
  patch: Partial<Pick<UserProfile, 'name' | 'avatarPath'>>,
): Promise<UserProfile> {
  const current = await load(ownerId);
  const next: UserProfile = {
    ...current,
    ...(patch.name !== undefined ? { name: validateName(patch.name) } : {}),
    ...(patch.avatarPath !== undefined
      ? { avatarPath: validateAvatarPath(patch.avatarPath, ownerId) }
      : {}),
  };
  await persist(ownerId, next);
  cache.set(ownerId, next);
  return next;
}

/** 启动时调用，确保文件存在（首次启动会触发 default 写盘） */
export async function ensureProfileExists(ownerId: string): Promise<void> {
  await load(ownerId);
}

/** 测试用：清缓存（让下次 load 强制读盘） */
export function __resetProfileCache(): void {
  cache.clear();
}
