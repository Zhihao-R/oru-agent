/**
 * agents.* 命令处理器（D2(a) 迁移域）。行为与原 router.ts switch 内 agents.* 各 case 字节级一致——纯搬运。
 */
import type { ServerEventPayload } from '@shared/protocol';
import type { Broadcast, Reply } from '../server';
import type { RegistrySlice } from './types';
import { listAgents, updateAgent } from '../../agent/store/agents';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';

async function pushAgentsState(reply: Reply | null, reqId: string | null, broadcast: Broadcast) {
  const { agents, activeId } = await listAgents();
  const ev: ServerEventPayload = { type: 'agents.state', agents, activeId };
  if (reply && reqId) reply(reqId, ev);
  broadcast(ev);
}

export const agentHandlers = {
  'agents.list': async (req, { reply, broadcast }) => {
    await pushAgentsState(reply, req.reqId, broadcast);
  },
  'agents.update': async (req, { reply, broadcast }) => {
    await updateAgent(req.agentId, req.patch);
    await pushAgentsState(reply, req.reqId, broadcast);
  },
  'agents.avatar.upload': async (req, { reply, broadcast }) => {
    const { saveAgentAvatar } = await import('../../agent/store/avatar');
    const ownerId = getCurrentOwnerId();
    const path = await saveAgentAvatar(ownerId, req.agentId, req.base64Png);
    await updateAgent(req.agentId, { avatarPath: path });
    reply(req.reqId, { type: 'agents.avatar.upload.result', agentId: req.agentId, path });
    // 让其他客户端订阅到 agents.state 更新（纯广播，不带 reqId）
    await pushAgentsState(null, null, broadcast);
  },
} satisfies RegistrySlice;
