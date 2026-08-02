/**
 * 密钥保管（S07·G55）——厂商 API key 从明文配置迁入系统级加密保管。
 *
 * 用 Electron `safeStorage`（底层：macOS Keychain / Windows DPAPI / Linux libsecret），
 * 密文与「本机 + 本 OS 用户」绑定：换机后那份密文本就解不开——这正是备份「不带明文密钥」
 * 时想要的性质（见 exportBackup），也是 data-durability「影子豁免」精神的延伸。
 *
 * 落盘形态：加密后的 key 在 config.json 里存为 `oru-enc:v1:<base64密文>` 字符串。
 * 前缀既是版本号也是「已加密」判据——decrypt 见前缀才解，没前缀视作存量明文原样放行
 * （下次 persist 自动加密，复用既有 manualApiKey 迁移的「读时兼容、写时固化」路数）。
 *
 * 边界：内存态（store 缓存、所有消费方）永远是明文；加解密只发生在 store 的
 * load / persist 落盘边界这一处。加密不可用（无 keychain 的 Linux headless）时降级明文
 * 保管——绝不因为加不了密就把用户的 key 弄丢。
 */
import { safeStorage } from 'electron';

/** 已加密密钥的前缀：既标版本又当「是否已加密」的判据 */
const SECRET_PREFIX = 'oru-enc:v1:';

/** 本机是否具备系统级加密能力（无 keychain 的环境返回 false） */
export function isSecretEncryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** 是否是本内核加密过的密文（带前缀） */
export function isEncryptedSecret(value: string): boolean {
  return typeof value === 'string' && value.startsWith(SECRET_PREFIX);
}

/**
 * 加密一个密钥用于落盘。空串原样返回（无 key 不加密）；已是密文则不重复加密；
 * 加密不可用时降级返回明文（不丢钥）。
 */
export function encryptSecret(plain: string): string {
  if (!plain) return plain;
  if (isEncryptedSecret(plain)) return plain;
  if (!isSecretEncryptionAvailable()) return plain;
  return SECRET_PREFIX + safeStorage.encryptString(plain).toString('base64');
}

/**
 * 解密一个落盘密钥回明文。非密文（存量明文 / 空串）原样返回；
 * 解不开（换机、keychain 变动、密文损坏）返回空串——视作「无 key」，触发用户重填，
 * 绝不把解不开的乱码当 key 喂给厂商。
 */
export function decryptSecret(stored: string): string {
  if (!isEncryptedSecret(stored)) return stored;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(SECRET_PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}
