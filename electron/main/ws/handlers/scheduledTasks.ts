/**
 * scheduledTask.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 scheduledTask.* 各 case 字节级一致——纯搬运。
 * 注：handler 比 router 深一层目录，相对动态 import 路径相应多一层 `../`。
 *
 * fallthrough 还原：原 switch 里 create/update/delete/setEnabled 共用一段 body、
 * run/dismissMissed 共用一段 body（body 内按 req.type 分支）。这里各用一个本地 async
 * 函数承载，对应 type 都映射到它，req.type 判断原样保留。
 */
import { ErrorCodes } from '@shared/types';
import type { ClientRequestPayload } from '@shared/protocol';
import type { CommandCtx, RegistrySlice } from './types';
import { pushScheduledTaskState } from './convState';
import { listAgents } from '../../agent/store/agents';

// ⋯「立即执行」：补跑一次（runTaskNow）。建/改/删/启停/错过区都走组端点（handleGroupMutate）。
type RunReq = Extract<ClientRequestPayload, { type: 'scheduledTask.run' }> & { reqId: string };
const handleRun = async (req: RunReq, { reply, broadcast }: CommandCtx): Promise<void> => {
  const sched = await import('../../scheduledTasks/scheduler');
  await sched.runScheduledTaskNow(req.id);
  await pushScheduledTaskState(reply, req.reqId, broadcast);
};

// 组写端点（多触发规则）：建/改/停/删/组级错过动作——全走 groupOps 唯一入口，成功后广播全端状态。
// 建/改可能因非法 spec / interval 缺次数 throw → 回 error 回包（与单条 create/update 同口径）。
type GroupMutateReq = Extract<
  ClientRequestPayload,
  {
    type:
      | 'scheduledTask.createGroup'
      | 'scheduledTask.updateGroup'
      | 'scheduledTask.setGroupEnabled'
      | 'scheduledTask.deleteGroup'
      | 'scheduledTask.runGroupMissed'
      | 'scheduledTask.dismissGroupMissed';
  }
> & { reqId: string };
const handleGroupMutate = async (req: GroupMutateReq, { reply, broadcast }: CommandCtx): Promise<void> => {
  const ops = await import('../../scheduledTasks/groupOps');
  try {
    if (req.type === 'scheduledTask.createGroup') {
      const { activeId } = await listAgents();
      const { getCurrentOwnerId } = await import('../../identity/getCurrentOwnerId');
      await ops.createTaskGroup(req.input, {
        ownerId: getCurrentOwnerId(),
        agentId: activeId ?? 'twin',
        createdBy: 'user',
      });
    } else if (req.type === 'scheduledTask.updateGroup') {
      await ops.updateTaskGroup(req.groupId, req.input);
    } else if (req.type === 'scheduledTask.setGroupEnabled') {
      await ops.setTaskGroupEnabled(req.groupId, req.enabled);
    } else if (req.type === 'scheduledTask.deleteGroup') {
      await ops.deleteTaskGroup(req.groupId);
    } else if (req.type === 'scheduledTask.runGroupMissed') {
      await ops.runGroupMissed(req.groupId);
    } else {
      await ops.dismissGroupMissed(req.groupId);
    }
  } catch (e) {
    reply(req.reqId, {
      type: 'error',
      code: ErrorCodes.SCHEDULE_INVALID,
      message: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  await pushScheduledTaskState(reply, req.reqId, broadcast);
};

export const scheduledTaskHandlers = {
  'scheduledTask.list': async (req, { reply }) => {
    const schedRpc = await import('../../scheduledTasks/rpc');
    // 单一 helper（带 groups·M1）；scope 组层过滤（M2）
    reply(req.reqId, await schedRpc.buildScheduledStatePayload(req.scope));
  },
  'scheduledTask.run': (req, ctx) => handleRun(req, ctx),
  'scheduledTask.createGroup': (req, ctx) => handleGroupMutate(req, ctx),
  'scheduledTask.updateGroup': (req, ctx) => handleGroupMutate(req, ctx),
  'scheduledTask.setGroupEnabled': (req, ctx) => handleGroupMutate(req, ctx),
  'scheduledTask.deleteGroup': (req, ctx) => handleGroupMutate(req, ctx),
  'scheduledTask.runGroupMissed': (req, ctx) => handleGroupMutate(req, ctx),
  'scheduledTask.dismissGroupMissed': (req, ctx) => handleGroupMutate(req, ctx),
  'scheduledTask.inflight': async (req, { reply }) => {
    // 后台执行中的任务 id（S18）——前端重载后据此恢复「执行中」指示（应用重启执行体不存活、返回空）。
    const { getInflightScheduledRuns } = await import('../../scheduledTasks/executor');
    reply(req.reqId, { type: 'scheduledTask.inflight.result', taskIds: getInflightScheduledRuns() });
  },
  'scheduledTask.preview': async (req, { reply }) => {
    const schedRpc = await import('../../scheduledTasks/rpc');
    const { getSettings } = await import('../../projects/store');
    const { resolveEffectiveLang } = await import('../../i18n/effectiveLang');
    const { tFor } = await import('../../i18n/t');
    const tt = tFor(resolveEffectiveLang((await getSettings().catch(() => null))?.language));
    try {
      const { frequency, runs } = schedRpc.preview(req.spec, tt);
      reply(req.reqId, { type: 'scheduledTask.preview.result', frequency, runs });
    } catch (e) {
      reply(req.reqId, {
        type: 'scheduledTask.preview.result',
        frequency: e instanceof Error ? e.message : tt('scheduledTask:fmt.unparseable'),
        runs: [],
      });
    }
  },
} satisfies RegistrySlice;
