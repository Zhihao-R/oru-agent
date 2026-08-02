/**
 * 自动归档（对话归档）：久不互动的对话自动收进「已归档」区。
 *
 * 归档是 archivedAt 状态，与时间维度的「更早」正交——到点写入，对话内再产生新消息（appendMessage）
 * 或清空（clearConversation）时清除。渠道消息不落进归档对话（寻址排除、另起一段），故不会激活旧段
 * （S11 · G83）。后端扫描刻意不判 active：「正在看的对话」豁免放在前端显示兜底（tech design §二），
 * 扫描保持单纯。
 *
 * 副作用生命周期：start 注册 interval、stop 清除（index.ts whenReady / before-quit 成对）。
 */
import type { AutoArchiveSettings } from '@shared/types';
import { listAgents } from '../agent/store/agents';
import { listConversations, archiveConversation } from './store';
import { getSettings } from '../projects/store';
import { createSystemRoutine } from '../runtime/systemRoutine';

const SCAN_INTERVAL_MS = 5 * 60_000; // 归档是分钟级动作，扫描周期可宽

type Broadcast = (agentId: string) => void | Promise<void>;
let broadcast: Broadcast | null = null;

// 统一调度内核（G44）：interval 扫描 + 开机即扫；启停/防重入（原 scanInflight）由内核保证。
const routine = createSystemRoutine({
  id: 'autoArchive',
  trigger: { kind: 'interval', everyMs: SCAN_INTERVAL_MS },
  run: tick,
  runOnStart: true,
});

/**
 * 纯判定：返回应归档的 conv id。未归档（archivedAt 空）且 now-updatedAt 超阈值才选。
 * thresholdHours clamp 到 ≥1——0/负数会让 now-updatedAt>0 命中一切、瞬间清空活跃区。
 */
export function pickConversationsToArchive(
  convs: { id: string; updatedAt: number; archivedAt?: number }[],
  now: number,
  thresholdHours: number,
): string[] {
  const cutoff = Math.max(1, thresholdHours) * 3_600_000;
  return convs.filter((c) => c.archivedAt == null && now - c.updatedAt > cutoff).map((c) => c.id);
}

/**
 * 编排一轮归档：enabled 关则不动；否则遍历 agent 归档超阈值的 sub，每个有命中的 agent
 * 触发一次 onArchived（广播刷新）。返回所有被归档的 conv id。
 */
export async function runAutoArchive(opts: {
  agentIds: string[];
  settings: AutoArchiveSettings | undefined;
  now: number;
  onArchived?: (agentId: string) => void | Promise<void>;
}): Promise<string[]> {
  if (!opts.settings?.enabled) return [];
  const cutoff = Math.max(1, opts.settings.thresholdHours) * 3_600_000;
  // 归档前入锁重检的截止点：扫描快照到执行之间用户可能发了消息（updatedAt 刷新）——
  // archiveConversation 据此跳过刚活跃的对话，不误归档。
  const inactiveSince = opts.now - cutoff;
  const archived: string[] = [];
  for (const agentId of opts.agentIds) {
    const convs = await listConversations(agentId);
    const ids = pickConversationsToArchive(convs, opts.now, opts.settings.thresholdHours);
    const done: string[] = [];
    for (const id of ids) {
      const r = await archiveConversation(agentId, id, { onlyIfInactiveSince: inactiveSince });
      if (r) done.push(id);
    }
    if (done.length) {
      archived.push(...done);
      await opts.onArchived?.(agentId);
    }
  }
  return archived;
}

export function start(injectedBroadcast: Broadcast): void {
  broadcast = injectedBroadcast;
  routine.start();
}

export function stop(): void {
  routine.stop();
  broadcast = null;
}

/**
 * 活跃驱动催一轮归档扫描（G27）——回合收尾顺带触发，让归档不只靠 5 分钟定时器（定时器降为兜底）。
 * 刚活跃的本对话 updatedAt 已刷新、不会被这轮归档；扫的是其他久不互动的对话。防重入由内核保证。
 */
export function triggerScan(): void {
  routine.trigger();
}

async function tick(): Promise<void> {
  const settings = await getSettings();
  const { agents } = await listAgents();
  await runAutoArchive({
    agentIds: agents.map((a) => a.id),
    settings: settings.autoArchive,
    now: Date.now(),
    onArchived: (agentId) => broadcast?.(agentId),
  });
}
