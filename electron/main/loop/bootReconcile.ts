/**
 * Loop 跨重启 boot 对账（S22·G61，2026-07-28 去特殊化 T3 修订）——启动扫描残留运行态快照，
 * 每个「跑到一半」的循环在其承载对话落一张**纯陈列**的 interrupted 终态卡（停在第几轮、清单达标
 * 到哪，无按钮），落卡后删快照。**不弹「续跑/作罢」询问**——断了想续与普通对话同规矩：用户再发
 * 一条带 Loop 标记的「继续」，拆解经 projectContextTail 的中断卡投影看得到进度、拆出接续的标准。
 * 与后台任务登记表 / scheduledTasks 的 boot reconcile 同挂载点、同思想。
 */
import type { ServerEventPayload } from '@shared/protocol';
import type { ChatMessage } from '@shared/types';
import { appendMessage, readHistory } from '../conversations/store';
import { getSettings } from '../projects/store';
import { listLoopRunStates, deleteLoopRunState } from './persist';

/** 扫描残留快照 → 逐个落 interrupted 终态卡（持久化 + 广播）并删快照。返回处理的 loopId 数（供日志/测试）。 */
export async function reconcileLoopRunsOnBoot(
  broadcast: (ev: ServerEventPayload) => void,
): Promise<string[]> {
  const states = await listLoopRunStates();
  const maxRounds = (await getSettings().catch(() => null))?.loopMaxRounds ?? 5;
  const done: string[] = [];
  for (const s of states) {
    const cardId = `loopcard_${s.loopId}`;
    // 幂等（崩溃窗口）：同 id 卡已在历史（终态卡落盘后、删快照前崩溃——含正常收敛的 done 卡）
    // → 只删快照、不再追加，否则历史里出现两张同 id 且可能内容矛盾的卡（「已收敛」vs「被打断」）。
    const already = (await readHistory(s.agentId, s.conversationId)).some((m) => m.id === cardId);
    if (already) {
      await deleteLoopRunState(s.loopId).catch((e) => console.warn('[loop] boot 对账删快照失败:', e));
      done.push(s.loopId);
      continue;
    }
    const message: ChatMessage = {
      id: cardId,
      conversationId: s.conversationId,
      role: 'assistant',
      text: '',
      toolCalls: [],
      createdAt: Date.now(),
      done: true, // 终态：纯陈列，不等任何决定
      kind: 'loop-checklist',
      loopCard: {
        loopId: s.loopId,
        goal: s.goal,
        phase: 'interrupted',
        round: s.round,
        maxRounds,
        checklist: s.checklist,
        endedAt: Date.now(), // 中断态从本次 boot 起陈列，下一条消息后退场（快照已删，不会再次复活）
      },
    };
    await appendMessage(s.agentId, s.conversationId, message);
    broadcast({ type: 'chat.loopCard', conversationId: s.conversationId, message });
    // 卡已落盘（进度的唯一来源转入对话历史）→ 快照使命完成，删除；删失败不阻塞其他快照，
    // 下次 boot 由上面的同 id 幂等检查兜住（只删快照、不重复追加）。
    await deleteLoopRunState(s.loopId).catch((e) => console.warn('[loop] boot 对账删快照失败:', e));
    done.push(s.loopId);
  }
  return done;
}
