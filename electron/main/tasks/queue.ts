/**
 * 任务派工：去串行 + 并行起跑（2026-08-03，方案 review-rev 2 定稿）
 *
 * 按项目串行已按 channels.html「项目」一节（2026-07-10 PM 终审）裁决删除：同项目并行工作能踩到的
 * 共享资源已在文件写锁 + 记忆追加事件上兜住，不该在调度层按项目一刀切排队；语义冲突的正确防线是
 * 派工方对具体资源的判断，不是项目级串行。原实现是裁决未落实的漂移。
 *
 * 本模块从「按 projectKey 串行队列」改为「去重 + 直接并行起跑」：
 * - enqueue 立即起跑（无 pending 排队链），同一项目多个派工可同时执行。
 * - 幂等 / 守卫：status 非 pending 不入队；起跑即迁 executing（同步、无 await 间隙）——双击 execute、
 *   信任模式叠加的二次入队被非 pending 挡下（至多执行一次，拒绝=不执行）。
 * - 取消收敛：去串行后无排队项可撤，刹车 / 撤卡统一走 subagentRunner 的 per-task abort
 *   （activeTasks 单一路径，见 subagentRunner 防逃逸登记）。本模块不再持取消/队列登记。
 *
 * ⚠ 去串行后同项目并行 subagent 共享同一 git 工作树 / baseline / rollback，**确定性互踩**——这是设计
 * 理由（不是过时注释），并行后风险真实存在。隔离（per-task worktree）见
 * TODO: 2026-08-03-undone-git-worktree-isolation，不属本模块范畴，后续独立议题承接。
 */
import type { CodeActionProposal } from '@shared/types';
import type { ServerEventPayload } from '@shared/protocol';
import { runTask } from './subagentRunner';
import { notifyTaskTerminal } from './taskAnnouncer';
import { transitionProposal } from '../proposals/lifecycle';

type Emit = (ev: ServerEventPayload) => void;
type QueueItem = { proposal: CodeActionProposal; agentId: string; emit: Emit };
type RunFn = (item: QueueItem) => Promise<void>;

let activeRunFn: RunFn = (item) => runTask(item);

/**
 * 派工。起跑守卫 + 幂等后立即并行起跑，不排队、不阻塞调用方。
 *
 * 幂等（拒绝=不执行 / 至多一次）：
 * - status 非 pending 不入队（首行守卫）。起跑即迁 executing（runTaskItem 同步段），「双击 execute /
 *   信任模式叠加」的第二次入队在 status 已非 pending 时被挡；已 rejected 的迟到入队同样被挡（提案
 *   实例经 proposals Map 单例共享，状态即真相）。
 * - 去串行后无 pending 排队，无需按 proposalId 扫队列去重——第一个 enqueue 在同一同步栈内就迁
 *   executing，不存在两个 pending 的同一提案（方案 review-rev 2 定稿）。
 */
export function enqueue(item: QueueItem): void {
  if (item.proposal.status !== 'pending') return;
  void runTaskItem(item);
}

async function runTaskItem(item: QueueItem): Promise<void> {
  try {
    // 起跑守卫：入队后到起跑前可能被旁路置非 pending（如 turn 中止撤卡）——非 pending 不执行（拒绝=
    // 不执行）。读局部快照再判，避免 TS 属性收窄波及 await 后的重读判断。
    const statusAtStart: typeof item.proposal.status = item.proposal.status;
    if (statusAtStart !== 'pending') return;
    // 起跑才迁 executing（同步、无 await 间隙，不存在「已入队未迁态」可拒窗口；迁移后拒绝再无撤回
    // 路径，executing→rejected 非法，「至多执行一次」由此成立）。
    transitionProposal(item.proposal, 'executing', item.emit);
    await activeRunFn(item);
    // await 后重读再判：executed 仅表示「这次派工已跑完」，任务本身成败由 task.* 事件呈现，审批卡
    // 不复述结果（PM 定稿：卡片已决即静态）。
    if (item.proposal.status === 'executing') {
      transitionProposal(item.proposal, 'executed', item.emit);
    }
  } catch (e) {
    // runTask 正常不外抛（内部已 catch 落 task failed）；这里兜住 runFn 异常，让提案落终态、
    // 也避免 void 调用变成 unhandled rejection。
    if (item.proposal.status === 'executing') {
      transitionProposal(item.proposal, 'failed', item.emit, {
        failureMessage: (e as Error).message,
      });
    }
    console.error('[queue] 任务执行异常:', e);
  } finally {
    // task 到终态：即时触发该对话的主动播报（去抖 / 忙退避 / 去重都在 announcer 内消化）。
    // 去串行后触发点从「队列推进」变「每任务 finally」——每个任务各自播报，语义不变。
    notifyTaskTerminal(item.agentId, item.proposal.conversationId);
  }
}

/** 仅 smoke 测试用：替换 runFn，避免真打 Claude */
export function __setRunFnForTest(fn: RunFn): () => void {
  const prev = activeRunFn;
  activeRunFn = fn;
  return () => {
    activeRunFn = prev;
  };
}
