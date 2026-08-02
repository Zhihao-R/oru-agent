/**
 * 表格视图偏好托管存储——csv 列宽/整表行高按文件持久化，落到 ~/.oru 而非就地（不污染用户目录/git）。
 *
 * 寻址：sha256(fileKey).slice(0,32) + '.json'，fileKey = 工作文件绝对路径（与 fileHistory 同口径）。
 * 落盘封套：{ version:1, ...TablePrefs }——version 管结构级演进，读出的 TablePrefs 不含 version。
 * 偏好可丢：文件不存在 / 损坏 / 未知版本一律读成 null，降级优于报错（渲染层回落默认列宽即可）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { TablePrefs } from '@shared/protocol';
import { tablePrefsDir, fileKeySlug } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { createWriteQueue } from '../runtime/atomicStore';

// 当前落盘格式版本。改结构（非纯加可选字段）时 +1，老版本读成 null 走降级。
// 刻意不走 runtime/versionedRecord 的 makeVersionedCodec：那个原语把「封套」和「迁移链 +
// 迁移前备份」捆在一起，服务耐久数据（tasks/bg-commands…）；表格偏好是可丢的一次性偏好，
// 任何异常都直接降级为 null（不迁移、不备份、不保留旧文件），轻量封套自持更贴合根本目标。
const CURRENT_VERSION = 1;

// 串行所有写 + tmp+rename 原子写——读-改-写整块入 enqueue，避免撕裂（同 backgroundCommandStore）。
const { enqueue, writeAtomic } = createWriteQueue();

/** 落盘封套：业务字段之外多一个 version（读出时剥掉）。 */
type StoredPrefs = TablePrefs & { version: number };

function fileFor(fileKey: string): string {
  return join(tablePrefsDir(getCurrentOwnerId()), `${fileKeySlug(fileKey)}.json`);
}

/** 读该文件的偏好；不存在 / 损坏 / 版本不认识一律 null（不 throw）。 */
export async function readTablePrefs(fileKey: string): Promise<TablePrefs | null> {
  const raw = await fs.readFile(fileFor(fileKey), 'utf-8').catch(() => null);
  if (raw === null) return null; // 无偏好——正常，非错误
  try {
    const parsed = JSON.parse(raw) as StoredPrefs;
    if (!parsed || parsed.version !== CURRENT_VERSION) return null; // 未知版本按无偏好降级
    const { version: _version, ...prefs } = parsed;
    return prefs;
  } catch {
    return null; // 损坏字节按无偏好降级（偏好可丢）
  }
}

/** 写该文件的偏好（覆盖式）。整块入队串行 + 原子写。 */
export async function writeTablePrefs(fileKey: string, prefs: TablePrefs): Promise<void> {
  await enqueue(async () => {
    await fs.mkdir(tablePrefsDir(getCurrentOwnerId()), { recursive: true });
    // version 放最后——封套版本号是落盘结构版本，业务字段不得覆盖它（永远赢）。
    const stored: StoredPrefs = { ...prefs, version: CURRENT_VERSION };
    await writeAtomic(fileFor(fileKey), JSON.stringify(stored));
  });
}

/** 改名/移动后把偏好迁到新 fileKey（源不存在则静默无事）。整块入同一队列，与写互斥。 */
export async function relocateTablePrefs(oldFileKey: string, newFileKey: string): Promise<void> {
  await enqueue(async () => {
    const src = fileFor(oldFileKey);
    const raw = await fs.readFile(src, 'utf-8').catch(() => null);
    if (raw === null) return; // 源无偏好——静默
    await fs.mkdir(tablePrefsDir(getCurrentOwnerId()), { recursive: true });
    await writeAtomic(fileFor(newFileKey), raw);
    await fs.rm(src, { force: true });
  });
}
