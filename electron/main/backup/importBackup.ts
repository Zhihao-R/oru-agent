/**
 * 换机还原（S07·G125）——指向备份包，还原即完整复活。
 *
 * 还原是对身份数据破坏性最强的一次整体覆盖，纪律：
 *   1. 先校验 manifest（不是本格式 / 版本高于本程序 → 拒绝，绝不半还原）；
 *   2. 动手前把当前 owner 目录整体导出成一份「还原前兜底」备份（含密钥，放 ORU_DIR 顶层，
 *      不在被覆盖的 owner 目录内）——还原程序有 bug 时，损失止于「这次还原白做」，退得回去；
 *   3. 清空并重灌 owner 目录（payload 在包内 data/ 前缀下）；
 *   4. 密钥落回本机 keychain：包内 config 的明文 key（含密钥导出时才有）加密固化，闭合明文窗口。
 *
 * 还原后需重启应用（store 等缓存按旧数据构建）——重启由 handler 负责，本函数只管落盘。
 * 版本迁移不在这里做：各 store 读盘时天然走 migrateOnRead（S06），备份来自旧版应用也自动升级。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join, sep, relative, isAbsolute } from 'node:path';
import JSZip from 'jszip';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { ORU_DIR, userDir, configPath } from '../runtime/paths';
import { safeWriteAsync } from '../fs/safeWrite';
import { transformSettingsSecrets } from './secrets';
import { encryptSecret } from './keyVault';
import { buildBackupZip, BACKUP_MANIFEST_NAME, BACKUP_FORMAT, BACKUP_FORMAT_VERSION, BACKUP_PAYLOAD_PREFIX, type BackupManifest } from './exportBackup';

export class InvalidBackupError extends Error {}

/** abs 是否落在 root 目录之内（含 root 本身）——挡 Zip Slip 路径逃逸 */
export function isWithin(root: string, abs: string): boolean {
  const rel = relative(root, abs);
  return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel));
}

/** 校验并解析 manifest；非本格式或版本过高即抛 InvalidBackupError */
export function validateManifest(raw: unknown): BackupManifest {
  const m = raw as Partial<BackupManifest> | null;
  if (!m || m.format !== BACKUP_FORMAT) {
    throw new InvalidBackupError('这不是 Oru 备份包（缺少或不匹配的格式标识）');
  }
  if (typeof m.version !== 'number' || m.version > BACKUP_FORMAT_VERSION) {
    throw new InvalidBackupError(`备份包版本 ${m.version} 高于本程序支持的 ${BACKUP_FORMAT_VERSION}——请升级应用后再还原`);
  }
  return m as BackupManifest;
}

/** 把还原后 config.json 里的明文 key 加密固化回本机 keychain，闭合明文窗口 */
async function encryptRestoredKeysAtRest(ownerId: string): Promise<void> {
  const path = configPath(ownerId);
  if (!existsSync(path)) return;
  let parsed: { settings?: Parameters<typeof transformSettingsSecrets>[0]; version?: number };
  try {
    parsed = JSON.parse(await fs.readFile(path, 'utf-8'));
  } catch {
    return; // config 无法解析：交给下次正常读盘的损坏隔离，不在还原里节外生枝
  }
  if (!parsed.settings) return;
  const before = JSON.stringify(parsed.settings);
  transformSettingsSecrets(parsed.settings, encryptSecret); // 密钥字段清单单一来源，覆盖 webSearch 等全部
  if (JSON.stringify(parsed.settings) !== before) {
    await safeWriteAsync(path, JSON.stringify(parsed, null, 2));
  }
}

/**
 * 从备份包还原。返回还原前的兜底备份路径与包 manifest。
 * @param zipPath 备份包文件路径
 */
export async function restoreBackup(zipPath: string): Promise<{ safetyBackupPath: string; manifest: BackupManifest }> {
  const buf = await fs.readFile(zipPath);
  const zip = await JSZip.loadAsync(buf);

  // 1. 校验 manifest（先校验后动手，绝不半还原）
  const manifestFile = zip.file(BACKUP_MANIFEST_NAME);
  if (!manifestFile) throw new InvalidBackupError('这不是 Oru 备份包（缺少 manifest）');
  const manifest = validateManifest(JSON.parse(await manifestFile.async('string')));

  const ownerId = getCurrentOwnerId();
  const root = userDir(ownerId);

  // 2. 还原前兜底：当前 owner 目录整体导出（含密钥），放 ORU_DIR 顶层
  const safetyBackupPath = join(ORU_DIR, `pre-restore-${Date.now()}.oru-backup.zip`);
  const safety = await buildBackupZip({ includeKeys: true });
  await fs.mkdir(ORU_DIR, { recursive: true });
  await fs.writeFile(safetyBackupPath, safety);

  // 3. 清空并重灌 owner 目录
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  const entries = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith(BACKUP_PAYLOAD_PREFIX));
  for (const entry of entries) {
    const rel = entry.name.slice(BACKUP_PAYLOAD_PREFIX.length);
    if (!rel) continue;
    const abs = join(root, rel);
    // Zip Slip 守卫：备份包来自用户指向的外部文件，恶意条目名（含 ../）不得逃出 owner 目录写任意路径
    if (!isWithin(root, abs)) continue;
    await fs.mkdir(join(abs, '..'), { recursive: true });
    await fs.writeFile(abs, await entry.async('nodebuffer'));
  }

  // 4. 密钥加密固化回本机 keychain
  await encryptRestoredKeysAtRest(ownerId);

  return { safetyBackupPath, manifest };
}
