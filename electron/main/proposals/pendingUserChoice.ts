/**
 * 「带选项提问」的用户回答信箱——与 pendingDecision.ts 同构（同步审批的信箱）。
 *
 * ask_user_choice 工具 execute 内先按 askId 挂一个 deferred、再 emit 卡片、再 await——turn
 * 自然挂起等用户作答。router 的 chat.answerUserChoice 调 settle 唤醒，回答作为 tool_result 在
 * **原轮**回给模型，模型同一轮接着干。
 *
 * 为什么按 askId 而不是 conversationId 挂：模型一轮可并发发多个 ask_user_choice tool_use
 * （anthropic/openai 走 Promise.all），按 conversationId 单键会让第二个 ask 覆盖第一个 → 死锁。
 * askId 全局唯一，各 ask 各自独立，互不覆盖。
 *
 * 死锁防线两道（同 pendingDecision）：
 *   1. 只有挂了 ctx.askUserChoice（主对话、有 UI 能弹卡）的上下文才会进 await；背景 Twin /
 *      runOneShot / 对话期 subagent 不挂 → 工具优雅 isError，不进等待。
 *   2. abort（用户取消对话 / 本轮报错）经监听 signal 自动 reject，不留死 deferred。
 */
import type { AskUserChoiceAnswers, AskUserChoiceQuestion } from '@shared/types';

type WaiterEntry = {
  agentId: string;
  conversationId: string;
  questions: AskUserChoiceQuestion[];
  resolve: (a: AskUserChoiceAnswers) => void;
  reject: (e: Error) => void;
};

const waiters = new Map<string, WaiterEntry>();

/**
 * 挂起等某次提问的用户回答。注册（waiters.set）在返回 Promise 前同步完成——调用方应在 await 本
 * Promise 之前 emit 卡片，确保 waiter 早于任何 settle 就位。signal abort 时以 Error reject 并清理
 * （让 execute 抛 → 现有中断回合落盘接住）。askId 全局唯一，故无需处理同 id 重复注册。
 *
 * conversationId / questions 供睡眠唤醒对账用（listPendingAsksForConversation）：waiter 携带
 * 归属对话与卡内容，唤醒后能按对话捞回「还没答的提问卡」重新渲染。settle / abort 语义不变。
 */
export function awaitUserChoice(
  agentId: string,
  conversationId: string,
  askId: string,
  questions: AskUserChoiceQuestion[],
  signal: AbortSignal,
): Promise<AskUserChoiceAnswers> {
  return new Promise<AskUserChoiceAnswers>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('对话已取消'));
      return;
    }
    const cleanup = () => {
      if (!waiters.has(askId)) return false;
      waiters.delete(askId);
      signal.removeEventListener('abort', onAbort);
      return true;
    };
    const onAbort = () => {
      if (cleanup()) reject(new Error('对话已取消'));
    };
    waiters.set(askId, {
      agentId,
      conversationId,
      questions,
      resolve: (a) => {
        if (cleanup()) resolve(a);
      },
      reject: (e) => {
        if (cleanup()) reject(e);
      },
    });
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 唤醒对账用：列某个对话（belonging to agentId）「仍在等回答」的提问卡（waiter 还在、未被
 * settle / abort）。返回 { askId, questions }，供前端把睡着的卡重新画出来；回合已收尾
 * （waiter 已清）则查不到。
 */
export function listPendingAsksForConversation(
  agentId: string,
  conversationId: string,
): { askId: string; questions: AskUserChoiceQuestion[] }[] {
  const out: { askId: string; questions: AskUserChoiceQuestion[] }[] = [];
  for (const [askId, w] of waiters) {
    if (w.agentId === agentId && w.conversationId === conversationId) {
      out.push({ askId, questions: w.questions });
    }
  }
  return out;
}

/**
 * 唤醒对账用：枚举所有「仍有 waiter 在等」的对话（agentId + conversationId 成对）。
 * 供主进程 wake 侧把「卡片还在等回答」的对话一并算进在途列表推送。
 */
export function listPendingWaiterConvs(): { agentId: string; conversationId: string }[] {
  const seen = new Set<string>();
  const out: { agentId: string; conversationId: string }[] = [];
  for (const w of waiters.values()) {
    const k = `${w.agentId}:${w.conversationId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ agentId: w.agentId, conversationId: w.conversationId });
  }
  return out;
}

/**
 * 用户点「提交」时唤醒正在等待的工具。
 * @returns true = 确有工具在等（已 resolve）；false = 没有（已 abort / 已答过的重复提交）——调用方忽略即可。
 */
export function settleUserChoice(askId: string, answers: AskUserChoiceAnswers): boolean {
  const w = waiters.get(askId);
  if (!w) return false;
  w.resolve(answers);
  return true;
}

/** 派发失败时（emit 卡片抛错）主动让等待者 reject，清掉 waiter 避免死 deferred（同 abortProposalDecision）。 */
export function abortUserChoice(askId: string): void {
  waiters.get(askId)?.reject(new Error('提问卡派发失败'));
}
