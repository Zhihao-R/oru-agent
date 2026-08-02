/**
 * 迁移前原样副本 + 读时迁移的文件级组合（理想架构 S06 · G129）。
 *
 * data-durability「迁移前留原样副本」：迁移程序也是程序、也会有 bug，而它改写的是唯一一份
 * 身份数据；动手改写之前旧格式先原样复制一份——最坏情形从「数据没了」降为「这次升级白做」，
 * 退回旧版应用、换回副本即一切如初。与文件工作区「覆盖前快照」同理。
 *
 * migrateOnRead 保持纯执行器（不碰 fs），文件级关切（副本 IO）收在这里：adopter 用
 * migrateFileOnRead 一个调用点拿到「parse + 待迁移先留底 + 升级到最新」全套，忘不了留副本。
 */
import { existsSync } from 'node:fs';
import { safeWriteAsync } from '../fs/safeWrite';
import { migrateOnRead, type Migration } from './migrateOnRead';

/**
 * 把旧格式原样字节写到 `<file>.pre-v<N>.bak`。已存在则不覆盖——同版本反复读时，
 * 第一份才是「迁移前原样」，后来的读到的可能已是半迁移产物。
 * 后缀避开 `.json`：各 store 的目录扫描按 `.json` 认数据文件，副本绝不能被扫成数据。
 */
export async function preMigrationBackup(filePath: string, rawText: string, fromVersion: number): Promise<void> {
  const bak = `${filePath}.pre-v${fromVersion}.bak`;
  if (existsSync(bak)) return;
  await safeWriteAsync(bak, rawText);
}

/**
 * 读一份版本化 JSON 文件的标准流程：parse → 低于当前版本先落原样副本 → migrateOnRead 升级。
 * JSON 损坏 / version 字段非法照常抛给调用方（损坏隔离是 adopter 的既有路径，不在此吞）；
 * 未来版本原样返回（不迁移、不留副本），是否拒绝由 adopter 定（同 migrateOnRead 语义）。
 */
export async function migrateFileOnRead<T>(
  filePath: string,
  rawText: string,
  chain: ReadonlyArray<Migration>,
  baselineVersion: number,
): Promise<T> {
  const raw: unknown = JSON.parse(rawText);
  const currentVersion = baselineVersion + chain.length;
  const rawVersion = (raw as { version?: unknown } | null)?.version;
  const v = rawVersion === undefined ? baselineVersion : rawVersion;
  if (typeof v === 'number' && Number.isInteger(v) && v >= baselineVersion && v < currentVersion) {
    await preMigrationBackup(filePath, rawText, v);
  }
  return migrateOnRead<T>(raw, chain, baselineVersion);
}
