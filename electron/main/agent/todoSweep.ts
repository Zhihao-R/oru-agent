/**
 * 了结的计划清单在**下一轮开始时**清掉——不是本轮结束时。
 *
 * 为什么不在本轮结束时清，两个理由：
 *  - 用户多半不盯着回合跑完。卡片从「3/5」直接消失，读起来像计划被放弃而不是完成——恰好抹掉了
 *    这张卡最有价值的一帧。「留一份做完的清单是过期的当前进度」在下一轮开始时成立，在本轮刚结束
 *    时不成立。
 *  - Loop 干活轮每轮都跑完一个回合，但「回合结束」不等于「活干完」（审查员随后可能整条打回）。
 *    放到下一轮开始时清，若审查已打回，清单本就该重列，语义自洽。
 *
 * 不留任何回读入口：做过的事全在对话历史里，比清单摘要详细得多。卡住的项例外不是因为「历史里没
 * 有」，而是**那件活还没终结、下一轮可能接着做**——所以只要还有悬着的项就不清。
 *
 * **本函数永不抛**：它跑在 runChatAndPersist 的回合开始处，而那个函数对上游有「永不 reject」的
 * 契约（steeringTurnLoop 的 running 标记靠它 resolve 才交还，reject 会让整条对话之后只排队、
 * 再也起不了回合）。删一份过期清单没有权力中断用户的回合——删不掉就留痕、下一轮再试。
 */
import type { ServerEventPayload } from '@shared/protocol';
import { countOpenTodos } from '@shared/todo';
import { clearTodos, getTodos } from './todoStore';

export async function sweepSettledTodos(opts: {
  ownerId: string;
  agentId: string;
  convId: string;
  emit: (ev: ServerEventPayload) => void;
}): Promise<void> {
  const { ownerId, agentId, convId, emit } = opts;
  try {
    const items = await getTodos(ownerId, agentId, convId);
    if (items.length === 0 || countOpenTodos(items) > 0) return;
    await clearTodos(ownerId, agentId, convId);
    // 空清单即撤卡（前端 TodoPanel 的 items.length === 0 已能撤，界面侧无需改动）
    emit({ type: 'chat.todo', conversationId: convId, items: [] });
  } catch (e) {
    console.warn(`[todoSweep] conv=${convId} 清扫已了结的计划清单失败（回合照常开始）：`, e);
  }
}
