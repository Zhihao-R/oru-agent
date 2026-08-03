/**
 * proposal.* / task.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内各 case 字节级一致——纯搬运。
 * proposal.execute 是并发敏感路径（CLAUDE.md「await 后重检 proposal.status」那条即在此）：
 * await import 让出 event loop 后的所有 status 重检与提前 return 一个不漏。
 * 注：handler 比 router 深一层目录，相对动态 import 路径相应多一层 `../`。
 */
import { ErrorCodes } from '@shared/types';
import type { RegistrySlice } from './types';
import { getProposal, discardProposal } from '../../proposals/registry';
import { finalizeUserCancelledTask } from './brake';
import { settleApprovalDecision } from './settleApprovalDecision';
import { cancelTask } from '../../tasks/subagentRunner';
import { userAnswered, cancelTwinWait } from '../../tasks/askTwinBridge';
import { rollbackTask, redoRollback } from '../../git/rollback';

export const proposalTaskHandlers = {
  // ─── task / proposal ─────────────────────────────────────────
  // 桌面「允许 / 始终允许」——与渠道按钮回流共用 settleApprovalDecision 单一出口。
  // 决定收口（先到先得原子门、始终允许写授权、落存证、刷渠道投影、驱动执行）全在出口里，
  // handler 只做 404 兜底 + 转发 + ack（并发防抖由出口的 claim 保证，无需在此重检）。
  'proposal.execute': async (req, { reply, broadcast }) => {
    const proposal = getProposal(req.proposalId);
    if (!proposal) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.PROPOSAL_NOT_FOUND,
        message: `proposal not found: ${req.proposalId}`,
      });
      return;
    }
    await settleApprovalDecision({
      proposalId: proposal.id,
      decision: 'approved',
      always: req.always === true,
      by: { source: 'desktop' },
      broadcast,
    });
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'proposal.reject': async (req, { reply, broadcast }) => {
    const proposal = getProposal(req.proposalId);
    if (!proposal) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.PROPOSAL_NOT_FOUND,
        message: `proposal not found: ${req.proposalId}`,
      });
      return;
    }
    // 提案已在执行：拒绝无法生效——如实报错，不 ack 假装成功。追杀已起跑的 code 走 task.cancel。
    if (proposal.status === 'executing') {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.TASK_BUSY,
        message: `proposal already executing: ${proposal.id}`,
      });
      return;
    }
    await settleApprovalDecision({
      proposalId: proposal.id,
      decision: 'rejected',
      always: false,
      by: { source: 'desktop' },
      broadcast,
      note: req.note,
    });
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'task.cancel': async (req, { reply, broadcast }) => {
    const ok = cancelTask(req.taskId);
    if (!ok) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.TASK_NOT_FOUND,
        message: `task not running: ${req.taskId}`,
      });
      return;
    }
    // 撤悬着的审批卡 + markAnnounced 抑制播报（与对话级刹车同一收尾 helper）。
    // markAnnounced 走 patchTask 锁内 RMW，只打 announcedAt、不碰 status，与 catch 的
    // status='failed' 落盘顺序无关都各自保留（不会互相覆盖）。
    await finalizeUserCancelledTask(req.taskId, broadcast);
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'task.rollback': async (req, { reply, broadcast }) => {
    const r = await rollbackTask(req.taskId);
    if (r.ok) {
      broadcast({ type: 'task.statusChanged', taskId: req.taskId, status: 'rolled_back' });
      reply(req.reqId, { type: 'ack' });
    } else if (r.error === 'conflict') {
      broadcast({
        type: 'task.rollbackConflict',
        taskId: req.taskId,
        conflictPaths: r.conflictPaths,
      });
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.ROLLBACK_FAILED,
        message: `rollback conflict: ${r.conflictPaths.join(', ')}`,
      });
    } else {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.ROLLBACK_FAILED,
        message: `rollback failed: ${r.error}${'detail' in r && r.detail ? ` (${r.detail})` : ''}`,
      });
    }
    return;
  },
  'proposal.discard': async (req, { reply }) => {
    // 去串行后无排队项可撤（2026-08-03-async-subagent-de-serial-plan review-rev 2）：approve 即起跑，
    // discard 只作用于 pending 卡片、无法拦已起跑任务（executing 任务改由 cancelTask 语义承接）。
    // discard 语义是「悄悄丢弃、不告知模型、不留痕」，故不迁终态、不广播——proposal 整体被删、
    // status 再无读取方；已起跑任务照跑的取舍记录于 plan「已知限制/取舍」节。
    discardProposal(req.proposalId);
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'task.answerQuestion': async (req, { reply }) => {
    const ok = userAnswered(req.taskId, req.questionId, req.answer);
    if (!ok) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.TASK_NOT_FOUND,
        message: `no pending user answer for task ${req.taskId} question ${req.questionId}`,
      });
      return;
    }
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'task.cancelTwinWait': async (req, { reply }) => {
    const ok = cancelTwinWait(req.taskId);
    if (!ok) {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.TASK_NOT_FOUND,
        message: `no inflight twin background query for task ${req.taskId}`,
      });
      return;
    }
    reply(req.reqId, { type: 'ack' });
    return;
  },
  'task.rollback.confirm': async (req, { reply, broadcast }) => {
    // 用户在冲突 modal 里确认覆盖：跳过冲突检查
    const r = await rollbackTask(req.taskId, { skipConflictCheck: true });
    if (r.ok) {
      broadcast({ type: 'task.statusChanged', taskId: req.taskId, status: 'rolled_back' });
      reply(req.reqId, { type: 'ack' });
    } else {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.ROLLBACK_FAILED,
        message: `rollback failed: ${r.error}${'detail' in r && r.detail ? ` (${r.detail})` : ''}`,
      });
    }
    return;
  },
  'task.redoRollback': async (req, { reply, broadcast }) => {
    const r = await redoRollback(req.taskId);
    if (r.ok) {
      broadcast({ type: 'task.statusChanged', taskId: req.taskId, status: 'done' });
      reply(req.reqId, { type: 'ack' });
    } else {
      reply(req.reqId, {
        type: 'error',
        code: ErrorCodes.ROLLBACK_FAILED,
        message: `redo failed: ${r.error}${'detail' in r && r.detail ? ` (${r.detail})` : ''}`,
      });
    }
    return;
  },
} satisfies RegistrySlice;
