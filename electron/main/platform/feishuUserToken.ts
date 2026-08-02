/**
 * 飞书 user token 存储（S5 · user 身份自管）——device flow 拿到的 user_access_token /
 * refresh_token 存独立 0600 文件 feishu-user-token.json，对齐 credentialStore 红线 1：
 * 只在主进程、绝不进 config.json（config 会推渲染进程）、不靠环境变量透传。
 *
 * 与 credentialStore 分文件是有意的：app 凭证写入极罕见，user token 随刷新轮换频繁写，
 * 两者生命周期不同，互不拖累对方的写纪律（0600 预创建 + safeWriteAsync + chmod 双保险
 * 同一套，见 credentialStore.ts 注释）。
 *
 * token 只在其签发的应用下有意义：读面要求调用方给当前 appId，错位即 null（纵深防御；
 * 运维面 clearCredential 也会连带清本文件，见 ws/handlers/platform.ts）。
 *
 * 渲染进程永远拿不到密文——只能经 hasUserToken 查布尔、经授权状态事件看昵称/scope 元数据。
 */
import { promises as fs, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { userDir } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { safeWriteAsync } from '../fs/safeWrite';

export interface StoredUserToken {
  appId: string;
  userOpenId: string;
  /** 授权时抓到的昵称（设置页展示用）；抓不到留空。 */
  userName?: string;
  accessToken: string;
  refreshToken: string;
  /** access_token 过期时刻（Unix ms）。 */
  expiresAt: number;
  /** refresh_token 过期时刻（Unix ms）。 */
  refreshExpiresAt: number;
  scope: string;
  /** 首次授权时刻（Unix ms；刷新轮换不回写）。 */
  grantedAt: number;
}

function tokenPath(): string {
  return join(userDir(getCurrentOwnerId()), 'feishu-user-token.json');
}

export async function getUserToken(currentAppId: string): Promise<StoredUserToken | null> {
  try {
    const token = JSON.parse(await fs.readFile(tokenPath(), 'utf-8')) as StoredUserToken;
    // appId 错位即失效——换应用后旧 token 绝不可用（不就地清文件：运维面统一清，读面只拒）
    if (token.appId !== currentAppId) return null;
    return token;
  } catch {
    return null;
  }
}

export async function setUserToken(token: StoredUserToken): Promise<void> {
  const path = tokenPath();
  // 0600 预创建空文件——消除「首写 rename 落 0644 再 chmod」之间他人可读的窗口（同 credentialStore）
  if (!existsSync(path)) {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, '', { mode: 0o600 });
  }
  await safeWriteAsync(path, JSON.stringify(token, null, 2));
  await fs.chmod(path, 0o600); // 双保险
}

export async function clearUserToken(): Promise<void> {
  await fs.rm(tokenPath(), { force: true });
}

/** 给渲染进程查「是否已授权」——只回布尔，不回密文。 */
export async function hasUserToken(currentAppId: string): Promise<boolean> {
  return (await getUserToken(currentAppId)) !== null;
}

/** 提前 5 分钟视为将过期，给刷新留窗口（对齐上游 REFRESH_AHEAD_MS）。 */
const REFRESH_AHEAD_MS = 5 * 60 * 1000;

/**
 * token 新鲜度三态：
 * - valid：access_token 还能用（距过期 >5min）
 * - needs_refresh：access 将过期/已过期，但 refresh_token 仍有效
 * - expired：两个都过期——只能重新走 device flow 授权
 */
export function tokenStatus(
  token: Pick<StoredUserToken, 'expiresAt' | 'refreshExpiresAt'>,
  now: number = Date.now(),
): 'valid' | 'needs_refresh' | 'expired' {
  if (now < token.expiresAt - REFRESH_AHEAD_MS) return 'valid';
  if (now < token.refreshExpiresAt) return 'needs_refresh';
  return 'expired';
}
