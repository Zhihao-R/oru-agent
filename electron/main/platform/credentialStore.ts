/**
 * 平台凭证存储（PRD 红线 1）——App Secret / Bot Token 只在主进程、存独立文件
 * platform-credentials.json，**绝不进 config.json**（config 会推给渲染进程，凭证混进去即泄露），
 * 也不靠裸环境变量透传给子进程。文件权限 0600（仅属主可读，纵深防御）。
 *
 * 渲染进程只能经 hasCredential 查「是否已配置」（布尔），永远拿不到密文。
 */
import { promises as fs, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Platform } from '@shared/platform/message';
import { userDir } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { safeWriteAsync } from '../fs/safeWrite';

export interface FeishuCredential {
  appId: string;
  appSecret: string;
}
export interface DiscordCredential {
  botToken: string;
}
interface CredentialFile {
  feishu?: FeishuCredential;
  discord?: DiscordCredential;
}

function credPath(): string {
  return join(userDir(getCurrentOwnerId()), 'platform-credentials.json');
}

async function read(): Promise<CredentialFile> {
  try {
    return JSON.parse(await fs.readFile(credPath(), 'utf-8')) as CredentialFile;
  } catch {
    return {};
  }
}

async function write(data: CredentialFile): Promise<void> {
  const path = credPath();
  // 先以 0600 预创建空文件——safeWriteAsync 覆盖时保留既有权限，消除「首写 rename 落 0644 再 chmod」
  // 之间他人可读的窗口（红线 1 纵深防御）。空文件不含密文，预创建本身无泄露。
  if (!existsSync(path)) {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, '', { mode: 0o600 });
  }
  await safeWriteAsync(path, JSON.stringify(data, null, 2));
  await fs.chmod(path, 0o600); // 双保险
}

export async function setFeishuCredential(cred: FeishuCredential): Promise<void> {
  await write({ ...(await read()), feishu: cred });
}
export async function getFeishuCredential(): Promise<FeishuCredential | null> {
  return (await read()).feishu ?? null;
}
export async function setDiscordCredential(cred: DiscordCredential): Promise<void> {
  await write({ ...(await read()), discord: cred });
}
export async function getDiscordCredential(): Promise<DiscordCredential | null> {
  return (await read()).discord ?? null;
}

export async function clearCredential(platform: Platform): Promise<void> {
  const data = await read();
  delete data[platform];
  await write(data);
}

/** 给渲染进程查「是否已配置」——只回布尔，不回密文。 */
export async function hasCredential(platform: Platform): Promise<boolean> {
  return (await read())[platform] !== undefined;
}
