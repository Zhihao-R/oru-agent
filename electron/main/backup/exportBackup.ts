/**
 * 整体导出（S07·G124）——六类不可再生存储一键打成一份可带走的完整备份包。
 *
 * 第一性：备份对象就是整个 owner 数据目录 `~/.oru/users/<ownerId>/`（六类存储全在其下）。
 * 用「整目录 - 黑名单」而非「白名单列六类」——data-durability 页点名「让用户手抄目录清单必然
 * 抄漏」，同样的风险落在手维护的导出白名单上；黑名单式整目录导出，未来新增存储自动纳入。
 *
 * 黑名单只排「可再生影子」（判据：删掉能否从别处算回来）：
 *   - debug/ 调试 NDJSON 日志
 *   - *.pre-v<N>.bak 迁移前副本（S06 留的退路，可由再次迁移重算，是冗余）
 *   - *.tmp.<pid>.<seq> safeWrite 半截临时文件（静止态本不该有，稳妥起见排除）
 *
 * 两处「策展变换」（不是排除、是改写内容）：
 *   - conversations/<agentId>/index.json：置空 sdkSessionId——厂商会话指针属影子，豁免入包
 *     （见 data-durability「影子豁免」/ model-backend「弃号重灌」，换机后本地历史足以重建会话）
 *   - config.json：按用户「是否含密钥」选择——不含则清空 apiKey（换机后重填），含则写明文
 *     （落盘 config 存的是本机密文，明文入包必须显式解密——安全权衡已由 PM 拍板为导出时勾选）
 *
 * 包内布局：根放 oru-backup.json（manifest），owner 目录内容放 data/ 前缀下。
 */
import { promises as fs } from 'node:fs';
import { join, relative } from 'node:path';
import JSZip from 'jszip';
import { app } from 'electron';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { userDir } from '../runtime/paths';
import { decryptSecret } from './keyVault';
import { transformSettingsSecrets, SECRET_FILES } from './secrets';

export const BACKUP_MANIFEST_NAME = 'oru-backup.json';
export const BACKUP_FORMAT = 'oru-backup';
export const BACKUP_FORMAT_VERSION = 1;
/** owner 目录内容在 zip 内的前缀 */
export const BACKUP_PAYLOAD_PREFIX = 'data/';

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: number;
  exportedAt: number;
  appVersion: string;
  /** 备份包内是否含明文密钥（还原侧据此提示用户是否需重填） */
  includesKeys: boolean;
};

export type ExportOptions = { includeKeys: boolean };

/** 相对 owner 目录的路径是否属「可再生影子」，导出时整个跳过 */
export function isExcludedFromBackup(relPath: string): boolean {
  const segs = relPath.split('/');
  if (segs[0] === 'debug') return true; // 调试日志
  const name = segs[segs.length - 1];
  if (/\.pre-v\d+\.bak$/.test(name)) return true; // 迁移前副本（冗余）
  if (/\.tmp\.\d+\.\d+$/.test(name)) return true; // safeWrite 临时文件
  return false;
}

/**
 * 是否是需置空 sdkSessionId 的对话索引文件。
 * 三段假设钉死于磁盘布局 conversations/<agentId>/index.json（paths.ts convDir）——
 * 该布局变了要同步改这里，否则影子指针会静默漏进备份包。
 */
export function isConversationIndex(relPath: string): boolean {
  const segs = relPath.split('/');
  return segs.length === 3 && segs[0] === 'conversations' && segs[2] === 'index.json';
}

/** 置空对话索引里的 sdkSessionId（影子豁免）；解析失败则原样返回，绝不因此丢对话索引 */
export function stripSdkSessionId(rawJson: string): string {
  try {
    const parsed = JSON.parse(rawJson) as { conversations?: Array<Record<string, unknown>> };
    if (Array.isArray(parsed.conversations)) {
      for (const c of parsed.conversations) {
        if ('sdkSessionId' in c) c.sdkSessionId = null;
      }
    }
    return JSON.stringify(parsed, null, 2);
  } catch {
    return rawJson;
  }
}

/**
 * 按导出选项处理 config.json 的密钥（密钥字段清单由 backup/secrets 统一给出）：
 * 不含则清空、含则解密为明文。落盘 config 存的是本机密文，故 includeKeys 时须解密。
 */
export function transformConfigForExport(rawJson: string, includeKeys: boolean): string {
  let parsed: { settings?: Parameters<typeof transformSettingsSecrets>[0] };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    // config 解析失败：无法识别/剥离密钥字段，退回一个不含任何密钥的空 config，绝不原样带出
    return JSON.stringify({ settings: {} }, null, 2);
  }
  if (parsed.settings) {
    transformSettingsSecrets(parsed.settings, (stored) => (includeKeys ? decryptSecret(stored) : ''));
  }
  return JSON.stringify(parsed, null, 2);
}

/** 递归把 owner 目录内容按黑名单 + 变换加进 zip */
async function addDir(zip: JSZip, absRoot: string, absDir: string, opts: ExportOptions): Promise<void> {
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  for (const ent of entries) {
    const abs = join(absDir, ent.name);
    const rel = relative(absRoot, abs).split('\\').join('/');
    if (isExcludedFromBackup(rel)) continue;
    // 独立密钥文件（platform-credentials.json 等）：不含密钥导出时整文件排除
    if (!opts.includeKeys && SECRET_FILES.includes(rel)) continue;
    if (ent.isDirectory()) {
      await addDir(zip, absRoot, abs, opts);
    } else if (ent.isFile()) {
      let content: Buffer | string = await fs.readFile(abs);
      if (isConversationIndex(rel)) {
        content = stripSdkSessionId(content.toString('utf-8'));
      } else if (rel === 'config.json') {
        content = transformConfigForExport(content.toString('utf-8'), opts.includeKeys);
      }
      zip.file(BACKUP_PAYLOAD_PREFIX + rel, content);
    }
  }
}

/** 构建备份包，返回 zip 字节。密钥处理由 opts.includeKeys 决定（PM 拍板：导出时勾选）。 */
export async function buildBackupZip(opts: ExportOptions): Promise<Buffer> {
  const ownerId = getCurrentOwnerId();
  const root = userDir(ownerId);
  const zip = new JSZip();
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: Date.now(),
    appVersion: safeVersion(),
    includesKeys: opts.includeKeys,
  };
  zip.file(BACKUP_MANIFEST_NAME, JSON.stringify(manifest, null, 2));
  await addDir(zip, root, root, opts);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function safeVersion(): string {
  try {
    return app.getVersion();
  } catch {
    return 'unknown';
  }
}
