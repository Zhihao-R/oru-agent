/**
 * Loop 运行登记表——给进行中的 Loop 一个**外部可达的控制句柄**。
 *
 * runLoopOrchestration 是闭包、无对外接口：停不了、改不了标准。补一张模块级 `Map<loopId, LoopControl>`
 * （与 subagentRunner 的 activeTasks 同范式）：WS handler 按 loopId 找到控制句柄，把用户意图投递给编排层
 * ——停止立即 abort，改标准入队下一轮生效。收敛/中止/失败/用户停的 finally 里 unregisterLoop 清理
 * （CLAUDE.md 副作用生命周期）。v3 砍掉通病否决（vetoStandard）——通病归纳整链退场。
 */
import type { ChecklistEdit } from '@shared/types';

export type LoopControl = {
  loopId: string;
  conversationId: string;
  /** 停止：编排层置 stopRequested + ac.abort()，当前轮中断收尾、落 user-stopped 终态。 */
  stop: () => void;
  /** 改标准：入队一次编辑，下一轮边界生效（不打断当前轮）。 */
  requestChecklistEdit: (edit: ChecklistEdit) => void;
};

const active = new Map<string, LoopControl>();

export function registerLoop(c: LoopControl): void {
  active.set(c.loopId, c);
}

export function unregisterLoop(loopId: string): void {
  active.delete(loopId);
}

export function isLoopActive(loopId: string): boolean {
  return active.has(loopId);
}

/** 叫停进行中的 Loop。返回是否命中运行中的 Loop（未命中 = 已结束/不存在，静默）。 */
export function stopLoop(loopId: string): boolean {
  const c = active.get(loopId);
  if (!c) return false;
  c.stop();
  return true;
}

/**
 * 按对话叫停其上的活 loop（§3.2）——brake（Esc/删除/远程 /stop）路径调它：该对话若有活 loop，
 * stop 它（置 stopRequested + abort 当前干活轮），而非只停一个回合。返回是否命中。
 */
export function stopLoopForConversation(conversationId: string): boolean {
  for (const c of active.values()) {
    if (c.conversationId === conversationId) {
      c.stop();
      return true;
    }
  }
  return false;
}

/** 投递一次标准编辑。返回是否命中。 */
export function editLoopChecklist(loopId: string, edit: ChecklistEdit): boolean {
  const c = active.get(loopId);
  if (!c) return false;
  c.requestChecklistEdit(edit);
  return true;
}
