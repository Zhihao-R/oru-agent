/**
 * projects.* 命令处理器（D2(a) 首个迁移域）。
 * 行为与原 router.ts switch 内 `projects.list/add/remove/switch` 四个 case 字节级一致——纯搬运。
 */
import type { ServerEventPayload } from '@shared/protocol';
import type { Broadcast, Reply } from '../server';
import type { RegistrySlice } from './types';
import { addProject, listProjects, removeProject, switchProject } from '../../projects/store';
import { setActiveProjectId } from '../../agent/activeProject';

/** reply + broadcast 同一份项目全量状态（仅 projects.* 用；调用点全部非 null，故签名收窄）。 */
async function pushProjectsState(reply: Reply, reqId: string, broadcast: Broadcast) {
  const { projects, activeId } = await listProjects();
  const ev: ServerEventPayload = { type: 'projects.state', projects, activeId };
  reply(reqId, ev);
  broadcast(ev);
}

export const projectHandlers = {
  'projects.list': async (req, { reply }) => {
    const { projects, activeId } = await listProjects();
    reply(req.reqId, { type: 'projects.state', projects, activeId });
  },
  'projects.add': async (req, { reply, broadcast }) => {
    await addProject(req.path);
    // 添加项目时，如果还没 active 项目，新加的会自动 active（store 内部已处理）
    const { activeId } = await listProjects();
    if (activeId) setActiveProjectId(activeId);
    await pushProjectsState(reply, req.reqId, broadcast);
  },
  'projects.remove': async (req, { reply, broadcast }) => {
    await removeProject(req.id);
    const { activeId } = await listProjects();
    setActiveProjectId(activeId);
    await pushProjectsState(reply, req.reqId, broadcast);
  },
  'projects.switch': async (req, { reply, broadcast }) => {
    await switchProject(req.id);
    setActiveProjectId(req.id);
    await pushProjectsState(reply, req.reqId, broadcast);
  },
} satisfies RegistrySlice;
