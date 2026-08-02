/**
 * Loop 运行态跨重启快照——每轮边界落一份，重启后 boot 扫描认出「有循环跑到一半」，落一张纯陈列
 * 中断卡后删快照（2026-07-28 去特殊化 T3：恢复路径退役，快照只服务中断卡的数据来源——运行中伴随卡
 * 只广播不落盘，轮数与清单进度没有第二个出处）。
 *
 * 与后台任务登记表 / scheduledTasks 的 reconcileOnBoot 同思想。落盘走原子写（fs/safeWrite）；运行中覆盖
 * 同 loopId，终态（收敛/中止/停止/失败）删快照。
 * 版本封套：读时版本不符即弃（半截运行态不值得迁移，弃了只丢一张中断卡、不损坏数据）。
 * v3 砍掉派工账本与通病标准，快照只留最小集（loopId/conv/agent/goal/round/checklist）。
 */
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { LoopRunState, ChecklistItem } from '@shared/types';
import { loopRunsDir } from '../runtime/paths';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { safeWriteAsync } from '../fs/safeWrite';

/** v2→v3 快照形状变更（去账本/通病）——版本号跳到 2，任何存量 v1 快照读时即弃。 */
export const LOOP_SNAPSHOT_VERSION = 2;

/** 组装可 JSON 序列化的快照。纯函数。 */
export function buildRunState(args: {
  loopId: string;
  conversationId: string;
  agentId: string;
  goal: string;
  round: number;
  checklist: ChecklistItem[];
  now: number;
}): LoopRunState {
  return {
    version: LOOP_SNAPSHOT_VERSION,
    loopId: args.loopId,
    conversationId: args.conversationId,
    agentId: args.agentId,
    goal: args.goal,
    round: args.round,
    checklist: args.checklist,
    updatedAt: args.now,
  };
}

function fileFor(loopId: string): string {
  return join(loopRunsDir(getCurrentOwnerId()), `${loopId}.json`);
}

/** 落一份运行态快照（原子写，覆盖同 loopId）。 */
export async function saveLoopRunState(state: LoopRunState): Promise<void> {
  await safeWriteAsync(fileFor(state.loopId), JSON.stringify(state, null, 2));
}

/** 删快照（终态后调；不存在即静默）。 */
export async function deleteLoopRunState(loopId: string): Promise<void> {
  await fs.rm(fileFor(loopId), { force: true });
}

/**
 * 列出所有残留快照（boot 对账用）。版本不符即弃（跳过、不读），JSON 损坏跳过——半截运行态不值得抢救。
 */
export async function listLoopRunStates(): Promise<LoopRunState[]> {
  const dir = loopRunsDir(getCurrentOwnerId());
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // 目录不存在 = 从没跑过 loop
  }
  const out: LoopRunState[] = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(await fs.readFile(join(dir, n), 'utf-8')) as LoopRunState;
      if (parsed.version !== LOOP_SNAPSHOT_VERSION) continue; // 版本不符即弃
      out.push(parsed);
    } catch {
      // 损坏跳过（半截写盘 / 手改坏）——不崩、不阻塞其他快照
    }
  }
  return out;
}
