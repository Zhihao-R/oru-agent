/**
 * 提交中断轻量持久记录（项目B 第二期，PRD §六-6 / 技术设计 §4a）。
 *
 * 提交一批标注时（submitAnnotations 建组），落一条 `{groupId → conversationId, beforeVersionId}`。
 * **这不是把 live 提交组持久化**——Submission 模型仍只活内存（守"两态由 afterVersionId 派生"铁律）。
 * 这条小记录只服务崩溃后的两件事：
 *   - 「继续」：据 conversationId 切回原对话、预填 composer（走正常提交链路，不恢复 live 组）。
 *   - 「退回改前」：据 beforeVersionId 把 index.html checkout 回提交前。
 * 「已中断」是标注层派生展示态：status=submitted + groupId 无 live Submission + 有本记录。
 *
 * 落点 `.annotations/interruptions.json`，safeWrite 原子。组正常解散（finalize/stop/save/cancel）即清。
 */
import { promises as fs } from 'node:fs';
import { deckInterruptionsPath } from './pathResolver';
import { resolveDeckPath } from './store';
import { safeWriteAsync } from '../fs/safeWrite';

export type InterruptionRecord = {
  groupId: string;
  conversationId: string;
  beforeVersionId: string;
};

type InterruptionFile = { version: 1; records: InterruptionRecord[] };

// ── 按 path 核心（deck/html 共用，path = 中断记录 json 落点）─────────────────

async function readAt(path: string): Promise<InterruptionRecord[]> {
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as InterruptionFile;
    if (parsed?.version === 1 && Array.isArray(parsed.records)) return parsed.records;
  } catch {
    // 不存在/损坏——按无记录
  }
  return [];
}

async function writeAt(path: string, records: InterruptionRecord[]): Promise<void> {
  const file: InterruptionFile = { version: 1, records };
  await safeWriteAsync(path, JSON.stringify(file, null, 2));
}

/** 记一条中断记录（同 groupId 覆盖，幂等）。 */
export async function recordInterruptionAt(path: string, rec: InterruptionRecord): Promise<void> {
  const records = (await readAt(path)).filter((r) => r.groupId !== rec.groupId);
  records.push(rec);
  await writeAt(path, records);
}

export async function listInterruptionsAt(path: string): Promise<InterruptionRecord[]> {
  return readAt(path);
}

export async function getInterruptionAt(
  path: string,
  groupId: string,
): Promise<InterruptionRecord | undefined> {
  return (await readAt(path)).find((r) => r.groupId === groupId);
}

/** 清掉某 groupId 的记录（组正常解散时调，幂等）。 */
export async function clearInterruptionAt(path: string, groupId: string): Promise<void> {
  const records = await readAt(path);
  const next = records.filter((r) => r.groupId !== groupId);
  if (next.length !== records.length) await writeAt(path, next);
}

/** 只保留 groupId 在 keep 集里的记录——reconcile 清理失效（其标注已不再 submitted 该组）的残留。 */
export async function pruneInterruptionsAt(path: string, keep: ReadonlySet<string>): Promise<void> {
  const records = await readAt(path);
  const next = records.filter((r) => keep.has(r.groupId));
  if (next.length !== records.length) await writeAt(path, next);
}

// ── deck 适配器（artifactId → deckInterruptionsPath，旧签名/行为不变）──────────

async function deckPath_(artifactId: string): Promise<string> {
  return deckInterruptionsPath(await resolveDeckPath(artifactId));
}

export async function recordInterruption(artifactId: string, rec: InterruptionRecord): Promise<void> {
  await recordInterruptionAt(await deckPath_(artifactId), rec);
}
export async function listInterruptions(artifactId: string): Promise<InterruptionRecord[]> {
  return listInterruptionsAt(await deckPath_(artifactId));
}
export async function getInterruption(
  artifactId: string,
  groupId: string,
): Promise<InterruptionRecord | undefined> {
  return getInterruptionAt(await deckPath_(artifactId), groupId);
}
export async function clearInterruption(artifactId: string, groupId: string): Promise<void> {
  await clearInterruptionAt(await deckPath_(artifactId), groupId);
}
export async function pruneInterruptions(artifactId: string, keep: ReadonlySet<string>): Promise<void> {
  await pruneInterruptionsAt(await deckPath_(artifactId), keep);
}
