/**
 * 全量状态广播的两个小工具——对话列表状态（conv.state）与定时任务全量状态。
 *
 * 跨多个命令域共用的横切基础设施（列表/通知重算、审批续跑、定时面板刷新都靠它推权威态），
 * 从 shared.ts 按内聚度拆出（D2(a)）。
 */
import type { ServerEventPayload } from '@shared/protocol';
import type { Broadcast, Reply } from '../server';
import { listConversations } from '../../conversations/store';

export async function pushConvState(
  agentId: string,
  reply: Reply | null,
  reqId: string | null,
  broadcast: Broadcast,
) {
  const conversations = await listConversations(agentId);
  const ev: ServerEventPayload = { type: 'conv.state', agentId, conversations };
  if (reply && reqId) reply(reqId, ev);
  broadcast(ev);
}

/** 广播定时任务全量状态（对齐 pushConvState）。 */
export async function pushScheduledTaskState(
  reply: Reply | null,
  reqId: string | null,
  broadcast: Broadcast,
): Promise<void> {
  const { buildScheduledStatePayload } = await import('../../scheduledTasks/rpc');
  const ev: ServerEventPayload = await buildScheduledStatePayload();
  if (reply && reqId) reply(reqId, ev);
  broadcast(ev);
}
