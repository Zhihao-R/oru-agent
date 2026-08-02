/**
 * projects.* —— 经真 route() 验证命令注册表分发（D2(a) 首个迁移域）。
 *
 * 承重点：projects.list/add/remove/switch 已从 router 的 legacy switch 搬进 handlers/projects.ts，
 * 经 registry 查表分发。本测试驱动真 route() + harness，断言四条命令被正确分发、且回包/广播形态
 * 与迁移前一致——「该域命令能被独立测」本身就是迁移完成的判据。
 *
 * 用 vi.mock 替换 projects/store，使测试不碰真实 ORU_DIR / 磁盘（store 自身逻辑另有 store 测试覆盖）。
 * 这样既不污染共享 process.env（vitest worker 进程级共享 env），断言又能聚焦「分发 + 装配」本身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/types';
import type { Broadcast, Reply } from '../../electron/main/ws/server';
import type { ServerEventPayload } from '@shared/protocol';

// 内存版 projects store——记录调用并维护极简状态，供断言「handler 调对了 store + 回对了包」。
const store = {
  projects: [] as Project[],
  activeId: null as string | null,
  switchCalls: [] as string[],
  removeCalls: [] as string[],
};
function mkProject(path: string): Project {
  return { id: 'proj-1', ownerId: 'o', name: 'x', path, addedAt: 0, lastOpenedAt: 0, hasClaudeMd: false };
}
// mock 必须 satisfies 被 mock 的接口（CLAUDE.md 约定）——store 函数签名变化时这里编译失败而非假绿。
vi.mock('../../electron/main/projects/store', () => ({
  listProjects: async () => ({ projects: store.projects, activeId: store.activeId }),
  addProject: async (path: string) => {
    const p = mkProject(path);
    store.projects.push(p);
    store.activeId = p.id;
    return p;
  },
  removeProject: async (id: string) => {
    store.removeCalls.push(id);
    store.projects = store.projects.filter((p) => p.id !== id);
    store.activeId = store.projects[0]?.id ?? null;
  },
  switchProject: async (id: string) => {
    store.switchCalls.push(id);
    store.activeId = id;
    return mkProject('/x');
  },
  // router.ts 还从本模块 import 这几个（仅其它域 case 用，本测试不触发）——给桩满足 Pick 约束。
  getProject: vi.fn(),
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}) satisfies Pick<
  typeof import('../../electron/main/projects/store'),
  'listProjects' | 'addProject' | 'removeProject' | 'switchProject' | 'getProject' | 'getSettings' | 'updateSettings'
>);
const setActiveProjectId = vi.fn();
vi.mock('../../electron/main/agent/activeProject', () => ({
  setActiveProjectId: (id: string | null) => setActiveProjectId(id),
}) satisfies Pick<typeof import('../../electron/main/agent/activeProject'), 'setActiveProjectId'>);

import { route } from '../../electron/main/ws/router';

function harness() {
  const replies: ServerEventPayload[] = [];
  const broadcasts: ServerEventPayload[] = [];
  const reply: Reply = (_reqId, ev) => void replies.push(ev);
  const broadcast: Broadcast = (ev) => void broadcasts.push(ev);
  return { reply, broadcast, replies, broadcasts };
}

beforeEach(() => {
  store.projects = [];
  store.activeId = null;
  store.switchCalls = [];
  store.removeCalls = [];
  setActiveProjectId.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe('route(projects.*) 走命令注册表', () => {
  it('projects.list：回 projects.state（纯 reply、不广播）', async () => {
    const h = harness();
    await route({ type: 'projects.list', reqId: 'r1' }, h.reply, h.broadcast);
    expect(h.replies).toEqual([{ type: 'projects.state', projects: [], activeId: null }]);
    expect(h.broadcasts).toEqual([]);
  });

  it('projects.add：落库后 reply + broadcast 同一份 projects.state，并置 active', async () => {
    const h = harness();
    await route({ type: 'projects.add', reqId: 'r2', path: '/tmp/whatever' }, h.reply, h.broadcast);
    expect(h.replies).toHaveLength(1);
    expect(h.broadcasts).toHaveLength(1);
    const ev = h.replies[0] as Extract<ServerEventPayload, { type: 'projects.state' }>;
    expect(ev.type).toBe('projects.state');
    expect(ev.projects.map((p) => p.path)).toEqual(['/tmp/whatever']);
    expect(ev.activeId).toBe('proj-1');
    expect(setActiveProjectId).toHaveBeenCalledWith('proj-1');
    // pushProjectsState 语义：reply 与 broadcast 是同一份 state
    expect(h.broadcasts[0]).toEqual(ev);
  });

  it('projects.switch：调 switchProject + setActiveProjectId(req.id)，再推 state', async () => {
    const h = harness();
    await route({ type: 'projects.switch', reqId: 'r3', id: 'proj-9' }, h.reply, h.broadcast);
    expect(store.switchCalls).toEqual(['proj-9']);
    expect(setActiveProjectId).toHaveBeenCalledWith('proj-9');
    expect(h.replies[0]).toMatchObject({ type: 'projects.state' });
    expect(h.broadcasts).toHaveLength(1);
  });

  it('projects.remove：调 removeProject + setActiveProjectId(剩余 active)，再推 state', async () => {
    const h = harness();
    await route({ type: 'projects.remove', reqId: 'r4', id: 'proj-1' }, h.reply, h.broadcast);
    expect(store.removeCalls).toEqual(['proj-1']);
    expect(setActiveProjectId).toHaveBeenCalledWith(null);
    expect(h.replies[0]).toMatchObject({ type: 'projects.state' });
  });
});
