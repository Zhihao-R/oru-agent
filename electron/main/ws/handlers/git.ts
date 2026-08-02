/**
 * git.* 命令处理器（D2(a) 迁移域）。
 * 行为与原 router.ts switch 内 git.* 各 case 字节级一致——纯搬运。
 */
import type { RegistrySlice } from './types';
import { getProject } from '../../projects/store';
import { commitWithMessage, getDiff, getStatus, pushCurrentBranch } from '../../git/workflow';

export const gitHandlers = {
  'git.status': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const status = await getStatus(project.path);
    reply(req.reqId, { type: 'git.status.result', projectId: req.projectId, status });
  },
  'git.diff': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const diff = await getDiff(project.path);
    reply(req.reqId, { type: 'git.diff.result', projectId: req.projectId, diff });
  },
  'git.commit': async (req, { reply, broadcast }) => {
    const project = await getProject(req.projectId);
    const commit = await commitWithMessage(project.path, req.message);
    reply(req.reqId, {
      type: 'git.ok',
      projectId: req.projectId,
      action: 'commit',
      detail: commit,
    });
    const status = await getStatus(project.path);
    broadcast({ type: 'git.status.result', projectId: req.projectId, status });
  },
  'git.push': async (req, { reply }) => {
    const project = await getProject(req.projectId);
    const result = await pushCurrentBranch(project.path);
    reply(req.reqId, {
      type: 'git.ok',
      projectId: req.projectId,
      action: 'push',
      detail: result.pushed ? result.branch : `skipped: ${result.reason}`,
    });
  },
} satisfies RegistrySlice;
