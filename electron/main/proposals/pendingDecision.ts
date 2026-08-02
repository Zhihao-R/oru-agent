/**
 * 同步审批的「用户决定信箱」（替代旧的 fire-and-forget + maybeResumeTurn 续跑）。
 *
 * 根因：旧实现里工具 emit 提案后立即返回一句假文案「已递交…」给模型，turn 不挂起，模型拿着
 * 假结果继续往下跑；用户点确认是另一条异步线（独立执行器 + 起新轮）。两条线对不上拍，
 * 就是「点了审批他不知道」。
 *
 * 现在：proposeOrExecute 走审批时先按 proposalId 挂一个 deferred、再 emit 卡片、再 await——turn
 * 自然挂起等用户决定。router 的 proposal.execute / proposal.reject 调 settle 唤醒，工具批准则执行、
 * 真实结果作为 tool_result 在**原轮**回给模型，拒绝则回执文案，模型同一轮接着干。
 *
 * 死锁防线两道：
 *   1. 只有挂了 onProposal（有 UI 能弹卡、有人能点确认）的对话才会进 await（见 emitProposal.ts）；
 *      背景 / 无 UI 场景不挂 onProposal，不进同步等待。
 *   2. abort（用户取消对话）经内部监听 signal 自动 settle 成 'aborted'，不留死 deferred；
 *      派发失败也由调用方 cancel 清理。
 */
export type ProposalDecision = 'approved' | 'rejected' | 'aborted';

const waiters = new Map<string, (d: ProposalDecision) => void>();

/**
 * 「这张卡曾不曾有工具在同步等」——与 waiters 同模块、同一置位点，区别是 settle / abort 后**不删**：
 * waiters 是 live 状态（谁还在等），这个是留痕事实（谁等过）。
 *
 * 它取代了旧的 `isSyncKind`（按 kind 猜）。按 kind 猜只对「只有工具一个来源」的 kind 成立；装卸类
 * 同时有设置页入口，settle 唤不醒人的两种情形在那里必须分开：**从来没有工具在等**（设置页起的卡）
 * → 交独立执行器执行；**曾经有、但它走了**（对话 abort / 工具早退）→ 僵尸卡，置 rejected 不执行。
 *
 * 为什么是模块级 Set 而不是 `proposal.toolAwaited` 字段：`ActionProposal` 是 wire type——会序列化
 * 给渲染层、也会投影到渠道，主进程的运行时状态不该混进协议。代价是清理不能靠 GC，得显式挂在
 * 「该提案生命周期终结」的各出口（注册表离场 / 渠道路径就地终结 / 派发失败），见 forgetToolAwaited。
 */
const toolAwaited = new Set<string>();

export function hasToolAwaited(proposalId: string): boolean {
  return toolAwaited.has(proposalId);
}

/**
 * 提案生命周期终结时释放留痕标记，防长驻主进程里无界增长。三个出口：注册表离场（LRU 淘汰 /
 * discard）、渠道远程处置就地终结（那条路径永不进注册表）、派发失败早退（同上）。
 */
export function forgetToolAwaited(proposalId: string): void {
  toolAwaited.delete(proposalId);
}

/**
 * 挂起等某条提案的用户决定。注册（waiters.set）在返回 Promise 前同步完成——调用方应先 await 本函数
 * 拿到的 Promise 之前 emit 卡片，确保 waiter 早于任何 settle 就位。signal abort 时自动以 'aborted'
 * 兑现并清掉等待者。proposalId 全局唯一，故无需处理同 id 重复注册。
 */
export function awaitProposalDecision(proposalId: string, signal: AbortSignal): Promise<ProposalDecision> {
  // 留痕先于一切分支：signal 已 abort 的早退同样算「工具等过」——卡片照样 emit 出去，用户点确认时
  // 必须被判成僵尸卡（工具已走、不执行），而不是「从没人等」的设置页卡（会被独立执行器真做出来）。
  toolAwaited.add(proposalId);
  return new Promise<ProposalDecision>((resolve) => {
    if (signal.aborted) {
      resolve('aborted');
      return;
    }
    const finish = (d: ProposalDecision) => {
      if (!waiters.has(proposalId)) return;
      waiters.delete(proposalId);
      signal.removeEventListener('abort', onAbort);
      resolve(d);
    };
    const onAbort = () => finish('aborted');
    waiters.set(proposalId, finish);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 用户点确认 / 拒绝时唤醒正在等待的工具。
 * @returns true = 确有工具在同步等待（同步路径，由它执行并回结果）；
 *          false = 没有（设置页起的卡 / 背景场景 / 工具已走的僵尸卡），调用方按 hasToolAwaited 分辨这两者。
 */
export function settleProposalDecision(proposalId: string, decision: 'approved' | 'rejected'): boolean {
  const finish = waiters.get(proposalId);
  if (!finish) return false;
  finish(decision);
  return true;
}

/** 提案不再可能等到用户决定时主动让等待者以 'aborted' 兑现（与对话 abort 同果），清掉 waiter 避免死 deferred。调用方：派发失败早退、注册表离场（discard / LRU 淘汰）。 */
export function abortProposalDecision(proposalId: string): void {
  waiters.get(proposalId)?.('aborted');
}

/* ── 执行终态回报信箱 ──────────────────────────────────────────────
 * 同步审批路径的后半程：router 批准时只把卡片转 executing，真正的 executed/failed
 * 要等工具跑完才知道。工具侧（emitProposal）没有 broadcast 也摸不到 router 的
 * proposals Map，所以 router 在 settle 前注册一个 onFinalize 回调，工具在
 * execute() 完成 / 抛错后经 finalizeProposalExecution 回报终态——回调里由 router
 * 持有的 broadcast + proposal 引用完成状态迁移和广播。
 */

export type ProposalExecOutcome =
  | { status: 'executed' }
  | { status: 'failed'; failureMessage: string };

const finalizers = new Map<string, (outcome: ProposalExecOutcome) => void>();

/** router 批准前注册：保证工具回报终态时挂载点必定就位。 */
export function registerProposalFinalizer(
  proposalId: string,
  cb: (outcome: ProposalExecOutcome) => void,
): void {
  finalizers.set(proposalId, cb);
}

/** settle 落空（僵尸卡）时撤销注册，避免 Map 泄漏。 */
export function unregisterProposalFinalizer(proposalId: string): void {
  finalizers.delete(proposalId);
}

/**
 * 工具执行完成 / 抛错后回报终态（一次性，取出即删）。
 * 无注册时静默 no-op——信任模式与拒绝路径不注册 finalizer，也不会调到这里。
 */
export function finalizeProposalExecution(proposalId: string, outcome: ProposalExecOutcome): void {
  const cb = finalizers.get(proposalId);
  if (!cb) return;
  finalizers.delete(proposalId);
  cb(outcome);
}
