/**
 * Steering 崩溃盘记：入队即留 pending 盘记，消费前崩溃 → 重启扫描交还用户（预填草稿），
 * 绝不自动执行（2026-07-03 审计 critical#1，PM 拍板行为）。
 *
 * 磁盘布局跟着对话数据走（与 <convId>.jsonl / -images 同目录同款寻址）：
 *   conversations/<agentId>/<convId>.steering-pending.json    ← 活队列镜像（steeringQueue 同锁写/清）
 *   conversations/<agentId>/<convId>.steering-recovered.json  ← 崩溃残留，待交还（仅启动扫描写、ack 删）
 *
 * 每对话一份文件而非集中一册：盘记生命周期与对话绑定，且写入方 steeringQueue 本就 per-conv
 * 加锁——文件边界与锁边界重合，天然无跨对话写竞争，也免去集中文件的全局 RMW。
 *
 * pending / recovered 两个文件名分开是承重设计：扫描把残留「过户」到 recovered 后，本进程的
 * 新入队只写 pending——活队列的写/清绝不碰待交还的残留，二者生命周期互不踩踏。
 *
 * 交还清除点 = 前端送达确认（chat.steering.recoverAck）那一刻：确认前任何一步崩溃，残留
 * 都会在下次重启再交还（宁可交还重复、不可静默丢）；确认后即清（同一批不交还两次）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { safeWriteAsync } from '../fs/safeWrite';
import { convDir } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import type { SteeringBackup, SteeringMsg } from './steeringQueue';

const PENDING_SUFFIX = '.steering-pending.json';
const RECOVERED_SUFFIX = '.steering-recovered.json';

type BackupFile = { version: 1; pending: SteeringMsg[] };

function backupFile(agentId: string, convId: string, suffix: string): string {
  return join(convDir(getCurrentOwnerId()), agentId, `${convId}${suffix}`);
}

/** 读一份盘记文件；不存在/损坏 → []（tmp+rename 下损坏罕见，损坏即视为无可交还）。 */
async function readBackup(path: string): Promise<SteeringMsg[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf-8')) as Partial<BackupFile>;
    return Array.isArray(parsed.pending) ? parsed.pending : [];
  } catch {
    return [];
  }
}

/** steeringQueue 的盘记后端。key 恒为 steeringKey 产物 `agentId:conversationId`（nanoid 无冒号）。 */
export const fileSteeringBackup: SteeringBackup = {
  async save(key: string, pending: SteeringMsg[]): Promise<void> {
    const sep = key.indexOf(':');
    const agentId = key.slice(0, sep);
    const convId = key.slice(sep + 1);
    const file = backupFile(agentId, convId, PENDING_SUFFIX);
    if (pending.length === 0) {
      await fs.rm(file, { force: true });
      return;
    }
    await fs.mkdir(join(convDir(getCurrentOwnerId()), agentId), { recursive: true });
    await safeWriteAsync(file, JSON.stringify({ version: 1, pending } satisfies BackupFile));
  },
};

// ─── 崩溃恢复：启动扫描 → 待交还区 → 对话打开时预填草稿交还 ───────────────────

// S08 · G14：待交还区存 SteeringMsg 全量（含 trigger/kind/payload/attachments），交还时前端按
// handbackForm 分流为草稿 / 待处理项——不能像旧版 `map(m=>m.text)` 那样在扫描时把类型丢掉。
type RecoveredEntry = { agentId: string; msgs: SteeringMsg[] };

/** 待交还区（conversationId → 残留队列项）。只在启动扫描时填充；交还送达确认后删。 */
const recovered = new Map<string, RecoveredEntry>();

/**
 * 启动扫描（只扫 steering 盘记，不与任何其他登记表搅和）。必须在 ws server 接受请求之前跑完：
 * 扫描只认「进程启动时已存在」的文件——晚扫会把本进程新入队的活盘记误当崩溃残留。
 *
 * 对每个 conv：pending（上次进程的活队列残留）与 recovered（上上次未交还完的残留）合并、
 * 按时间序（更早的 recovered 在前）过户成一份 recovered 文件，pending 删除。
 * 崩在「写 recovered 后、删 pending 前」→ 下次扫描重复合并 → 重复交还（宁重复不丢）。
 */
export async function scanSteeringBackupsOnBoot(): Promise<void> {
  recovered.clear();
  const root = convDir(getCurrentOwnerId());
  let agentIds: string[];
  try {
    agentIds = await fs.readdir(root);
  } catch {
    return; // conversations 目录还不存在 = 全新安装，无残留
  }
  for (const agentId of agentIds) {
    let names: string[];
    try {
      names = await fs.readdir(join(root, agentId));
    } catch {
      continue; // 非目录条目（如 .DS_Store）
    }
    const convIds = new Set<string>();
    for (const n of names) {
      if (n.endsWith(PENDING_SUFFIX)) convIds.add(n.slice(0, -PENDING_SUFFIX.length));
      else if (n.endsWith(RECOVERED_SUFFIX)) convIds.add(n.slice(0, -RECOVERED_SUFFIX.length));
    }
    for (const convId of convIds) {
      const recFile = backupFile(agentId, convId, RECOVERED_SUFFIX);
      const penFile = backupFile(agentId, convId, PENDING_SUFFIX);
      const raw = [...(await readBackup(recFile)), ...(await readBackup(penFile))];
      // 向后兼容：S08 前的残留没有 trigger 字段（当时 steering 全是用户文本）——缺省补 'user'，
      // 否则 handbackForm 会把老草稿误判成待处理项。新代码写的盘记恒带 trigger，此补丁只惠及旧残留。
      const msgs = raw.map((m) => (m.trigger ? m : { ...m, trigger: 'user' as const }));
      if (msgs.length === 0) {
        // 空/损坏残留：清掉文件，不进待交还区（清不掉下次启动再试，无内容可丢）
        await fs.rm(recFile, { force: true }).catch(() => undefined);
        await fs.rm(penFile, { force: true }).catch(() => undefined);
        continue;
      }
      // 磁盘过户 per-conv 容错：单 conv 写盘/删文件失败只告警，不拖累其余 conv。
      // 且残留照进待交还区——它已完整读进内存，本会话仍能交还；不这么做的话，未过户的
      // pending 会被本进程同 conv 下次入队的全量镜像 save 整文件覆盖，残留静默蒸发
      // （正是本兜底要消灭的方向）。此后仅剩「本会话交还前再崩 + 期间盘上残留恰被覆盖」
      // 的双故障窗口，比引入黑名单让 save 永久区分残留/活队列两种生命周期划算。
      try {
        await safeWriteAsync(recFile, JSON.stringify({ version: 1, pending: msgs } satisfies BackupFile));
        await fs.rm(penFile, { force: true });
      } catch (e) {
        console.warn(`[oru.steering] 盘记过户失败（conv=${convId}，残留仍走本会话内存交还）:`, e);
      }
      recovered.set(convId, { agentId, msgs });
    }
  }
}

/** 该对话是否有待交还残留（conv.history 即对话打开时查）。无则 null。 */
export function peekRecoveredSteering(conversationId: string): SteeringMsg[] | null {
  return recovered.get(conversationId)?.msgs ?? null;
}

/** 交还送达确认：前端已把文本并入草稿——此刻才清盘记与待交还区（交还即清，不重复交还）。 */
export async function ackRecoveredSteering(conversationId: string): Promise<void> {
  const entry = recovered.get(conversationId);
  if (!entry) return; // 重复 ack / 无残留：幂等
  recovered.delete(conversationId);
  await fs.rm(backupFile(entry.agentId, conversationId, RECOVERED_SUFFIX), { force: true });
}

/** 对话删除时随之清盘记（pending/recovered 皆删）与待交还区——不留孤儿文件、不幽灵交还。 */
export async function deleteSteeringBackups(agentId: string, conversationId: string): Promise<void> {
  recovered.delete(conversationId);
  await fs.rm(backupFile(agentId, conversationId, PENDING_SUFFIX), { force: true });
  await fs.rm(backupFile(agentId, conversationId, RECOVERED_SUFFIX), { force: true });
}
