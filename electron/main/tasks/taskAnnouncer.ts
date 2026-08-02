/**
 * 终态主动播报（S09 · G69 后重构）：子 agent task 到终态后，把「后台任务完成」作为机器触发
 * 送进统一准入队列——空闲起播报轮、忙时排队回合末合并搭车。本模块只做两件事：
 * - 去抖窗合并同对话短时内连续完成的多个 task（一段话，不刷屏）；
 * - 去抖后调注入的 announce（= enqueueTaskCompletionAnnounce，由 index.ts 绑好 broadcast）。
 *
 * 「忙时放弃 + 30s 闲置轮询兜底 + announcing 互斥」整套旧机制退役：忙时不再丢（改入队），
 * 无需轮询捞漏（入队已覆盖），去重收敛到队列层（hasQueuedTrigger）与回合内 hint（announcedAt）。
 * 用户主动取消的 task 仍由 router 在 cancel 时 markAnnounced 抑制，不会被念“失败了”。
 */

/**
 * 由 index.ts 注入（避免 taskAnnouncer→router 循环依赖）：把该对话的后台完成送进统一队列播报。
 */
type Announce = (agentId: string, conversationId: string) => Promise<void>;

const DEBOUNCE_MS = 1_500; // 事件去抖窗：合并同对话短时内连续完成的 task

let announce: Announce | null = null;
// 事件去抖计时器（按 agentId::convId 键，新事件重置）
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

export function start(injectedAnnounce: Announce): void {
  announce = injectedAnnounce;
}

export function stop(): void {
  for (const t of debounceTimers.values()) clearTimeout(t);
  debounceTimers.clear();
  announce = null;
}

/**
 * task 到终态时由 queue 调：去抖窗后把该对话的后台完成送进统一队列播报。
 * 去抖窗内同对话的连续完成被合并成一次触发（多 task 一段话）。
 */
export function notifyTaskTerminal(agentId: string, conversationId: string): void {
  if (!announce) return;
  const key = `${agentId}::${conversationId}`;
  const prev = debounceTimers.get(key);
  if (prev) clearTimeout(prev);
  debounceTimers.set(
    key,
    setTimeout(() => {
      debounceTimers.delete(key);
      void announce?.(agentId, conversationId);
    }, DEBOUNCE_MS),
  );
}

/** 仅测试用：跳过去抖直接驱动注入的 announce。 */
export function __announceForTest(agentId: string, conversationId: string): Promise<void> {
  return announce ? announce(agentId, conversationId) : Promise.resolve();
}
