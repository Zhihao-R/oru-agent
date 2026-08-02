/**
 * 密钥面单一真相源（S07）——「config.json 里哪些字段是密钥、owner 目录里哪些文件是密钥」
 * 只在这里列一次。加密边界（store load/persist）、导出脱敏、还原固化三处都从这里派生，
 * 新增带 key 的配置只改本文件——避免 exportBackup 开篇痛斥的「手维护白名单必抄漏」在密钥
 * 这一层重演（review 实测：webSearch 引擎 key 就曾因三处各写各的被整条漏掉）。
 */
import type { Settings } from '@shared/types';
import { encryptSecret, decryptSecret } from './keyVault';

/** config.settings 里所有承载密钥的字段，用 fn 原地变换 */
type SecretBearingSettings = {
  providers?: Array<{ apiKey?: string }>;
  manualApiKey?: string | null;
  webSearch?: { engines?: Array<{ apiKey?: string }> };
};

/** 遍历 settings 的全部密钥字段施加 fn（原地写回）——唯一枚举密钥字段的地方 */
export function transformSettingsSecrets(
  settings: SecretBearingSettings,
  fn: (v: string) => string,
): void {
  for (const p of settings.providers ?? []) {
    if (typeof p.apiKey === 'string') p.apiKey = fn(p.apiKey);
  }
  if (typeof settings.manualApiKey === 'string' && settings.manualApiKey) {
    settings.manualApiKey = fn(settings.manualApiKey);
  }
  for (const e of settings.webSearch?.engines ?? []) {
    if (typeof e.apiKey === 'string') e.apiKey = fn(e.apiKey);
  }
}

/** 落盘：内存明文 settings → 密钥字段加密的深拷贝（不改原对象，缓存保持明文） */
export function encryptSettingsForDisk(settings: Settings): Settings {
  const copy = structuredClone(settings);
  transformSettingsSecrets(copy, encryptSecret);
  return copy;
}

/** 读盘：原地把 settings 的密钥字段解密回明文（存量明文无前缀原样放行） */
export function decryptSettingsInPlace(settings: Settings): void {
  transformSettingsSecrets(settings, decryptSecret);
}

/**
 * owner 目录下的「独立密钥文件」（相对路径）——不在 config.json 里、自成一份的密钥载体。
 * 不含密钥导出时整文件排除；含密钥导出时原样带走。新增此类文件只加进这个清单。
 */
export const SECRET_FILES: readonly string[] = ['platform-credentials.json', 'feishu-user-token.json'];
