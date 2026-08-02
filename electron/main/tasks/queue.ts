/**
 * 任务队列：同项目串行 / 跨项目并行
 *
 * 同项目串行避免：
 * - git baseline / branch 状态互相覆盖
 * - 两个子 agent 同时改同文件冲突
 * - rollback 起点错乱
 *
 * projectKey = proposal.targetProjectId ?? 'twin-home'（家目录任务也算一个独立 key）
 */
import type { CodeActionProposal } from '@shared/types';
import type { ServerEventPayload } from '@shared/protocol';
import { runTask } from './subagentRunner';
import { notifyTaskTerminal } from './taskAnnouncer';
import { transitionProposal } from '../proposals/lifecycle';

type Emit = (ev: ServerEventPayload) => void;
type QueueItem = { proposal: CodeActionProposal; agentId: string; emit: Emit };
type RunFn = (item: QueueItem) => Promise<void>;

const queues = new Map<string, { running: QueueItem | null; pending: QueueItem[] }>();
let activeRunFn: RunFn = (item) => runTask(item);

function projectKey(proposal: CodeActionProposal): string {
  return proposal.targetProjectId ?? 'twin-home';
}

/**
 * 入队。同 key 已有 running 时排队，否则立刻起；不阻塞调用方。
 *
 * 幂等去重（拒绝=不执行 / 至多执行一次）：
 * - 非 pending 的提案不入队——起跑即迁 executing（见 runWithDequeue），双击派工 /
 *   信任模式自动派工与手点叠加时，第二次入队看到的 status 已非 pending，静默幂等；
 *   已 rejected 的迟到入队同样被挡（提案实例经 proposals Map 单例共享，状态即真相）。
 * - 同提案还在排队（双方都 pending）时按 proposalId 扫队列去重。
 */
export function enqueue(item: QueueItem): void {
  if (item.proposal.status !== 'pending') return;
  const key = projectKey(item.proposal);
  const q = queues.get(key) ?? { running: null, pending: [] };
  queues.set(key, q);
  if (q.pending.some((it) => it.proposal.id === item.proposal.id)) return;
  if (q.running) {
    q.pending.push(item);
    return;
  }
  q.running = item;
  void runWithDequeue(key, item);
}

async function runWithDequeue(key: string, item: QueueItem): Promise<void> {
  try {
    // 起跑守卫：入队时还 pending，排队期间可能已被不走 cancelInQueue 的路径置成非
    // pending（如 turn 中止撤卡）——非 pending 一律不执行（拒绝=不执行），直接走
    // finally 推进队列。读进局部快照再判：避免 TS 属性收窄波及 await 后的重读判断。
    const statusAtStart: typeof item.proposal.status = item.proposal.status;
    if (statusAtStart !== 'pending') return;
    // 起跑才迁 executing（排队中保持 pending，reject 仍可经 cancelInQueue 撤下）；
    // 迁移后拒绝再无撤回路径（executing → rejected 非法），「至多执行一次」由此成立。
    // dequeue（shift）到这里无 await 间隙，不存在「已出队但还没迁状态」的可拒窗口。
    transitionProposal(item.proposal, 'executing', item.emit);
    await activeRunFn(item);
    // await 后重读再判：executed 仅表示「这次派工已跑完」，任务本身成败由 task.* 事件呈现，
    // 审批卡不复述结果（PM 定稿：卡片已决即静态）。
    if (item.proposal.status === 'executing') {
      transitionProposal(item.proposal, 'executed', item.emit);
    }
  } catch (e) {
    // runTask 正常不外抛（内部已 catch 落 task failed）；这里兜住 runFn 异常，
    // 让提案落终态、也避免 void 调用变成 unhandled rejection
    if (item.proposal.status === 'executing') {
      transitionProposal(item.proposal, 'failed', item.emit, {
        failureMessage: (e as Error).message,
      });
    }
    console.error('[queue] 任务执行异常:', e);
  } finally {
    // task 到终态：即时触发该对话的主动播报（去抖 / 忙退避 / 去重都在 announcer 内消化）
    notifyTaskTerminal(item.agentId, item.proposal.conversationId);
    const q = queues.get(key);
    if (!q) return;
    if (q.pending.length > 0) {
      const next = q.pending.shift();
      if (next) {
        q.running = next;
        void runWithDequeue(key, next);
        return;
      }
    }
    q.running = null;
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

/** 仅 smoke 测试用：清空所有队列 */
export function __resetQueuesForTest(): void {
  queues.clear();
}

/** 取消队列中的某个 proposal（尚未起跑），按 proposalId 匹配。已起跑的请用 cancelTask */
export function cancelInQueue(proposalId: string): boolean {
  for (const q of queues.values()) {
    const idx = q.pending.findIndex((it) => it.proposal.id === proposalId);
    if (idx >= 0) {
      q.pending.splice(idx, 1);
      return true;
    }
  }
  return false;
}

/**
 * 对话级刹车（理想架构 subagent.html#PFail）：把该对话「排队未起跑」的派工从所有
 * project 队列撤下（队列按 project 组织，但每个排队项的 proposal 都带 conversationId，
 * 据此跨队列反查）。返回被撤项的 proposal——状态流转（transitionProposal）是调用方的事，
 * 本函数只管队列；已起跑的用 cancelTasksForConversation。
 */
export function cancelQueuedForConversation(conversationId: string): CodeActionProposal[] {
  const removed: CodeActionProposal[] = [];
  for (const q of queues.values()) {
    for (let i = q.pending.length - 1; i >= 0; i--) {
      if (q.pending[i].proposal.conversationId === conversationId) {
        removed.push(...q.pending.splice(i, 1).map((it) => it.proposal));
      }
    }
  }
  return removed;
}

/** 暴露给监控用：每个 projectKey 当前排队长度 */
export function getQueueDepth(): Record<string, { running: boolean; pendingCount: number }> {
  const result: Record<string, { running: boolean; pendingCount: number }> = {};
  for (const [k, q] of queues.entries()) {
    result[k] = { running: q.running !== null, pendingCount: q.pending.length };
  }
  return result;
}

/**
 * 某 deck 是否已有生成任务在跑 / 在排（走查二批该修 4 的同 deck 去重判据）——队列是 running +
 * pending 的唯一真源（内存态、崩溃即清，与派工生命周期同界限），不另立登记表防双源漂移。
 */
export function deckTaskState(artifactId: string): 'running' | 'queued' | null {
  for (const q of queues.values()) {
    if (q.running?.proposal.deckContext?.artifactId === artifactId) return 'running';
    if (q.pending.some((it) => it.proposal.deckContext?.artifactId === artifactId)) return 'queued';
  }
  return null;
}
