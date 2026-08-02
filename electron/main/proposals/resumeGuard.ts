/**
 * 续跑单飞守卫（决策 5）。
 *
 * 把"判定该不该续 + 占位"这步同步化成一个原子操作：两条命令几乎同时跑完时，两个
 * maybeResumeTurn 都可能读到"无 pending"，若只靠后续的 isConversationBusy（它到 runChat
 * 真正占位之间隔着 await，有竞态窗口）会双双过关、起两轮。acquireResume 的判定 + 占位在
 * 任何 await 之前一气做完，第二个调用同步命中、拿不到令牌。
 *
 * 占位后所有早退路径都必须 releaseResume，否则该 conv 永久占位、再不续跑——调用方用
 * try/finally 保证（见 router.maybeResumeTurn）。
 */
const resuming = new Set<string>();

/**
 * 尝试取得某会话的"续跑令牌"。
 * @param pendingCount 该会话当前还有几条 pending 提案——>0 表示整批没处理完，不续。
 * @returns 取得令牌返回 true（调用方负责 release）；已有令牌或仍有 pending 返回 false。
 */
export function acquireResume(conversationId: string, pendingCount: number): boolean {
  if (pendingCount > 0) return false;
  if (resuming.has(conversationId)) return false;
  resuming.add(conversationId);
  return true;
}

/** 释放续跑令牌——续跑结束（成功/早退/抛错）后调用。 */
export function releaseResume(conversationId: string): void {
  resuming.delete(conversationId);
}
