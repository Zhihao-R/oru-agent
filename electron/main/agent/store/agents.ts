import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Agent } from '@shared/types';
import { ErrorCodes } from '@shared/types';
import { ensureAgentHome } from './home';
import { getCurrentOwnerId, LOCAL_USER_ID } from '../../identity/getCurrentOwnerId';
import { userDir, agentsDir, agentsIndex } from '../../runtime/paths';
import { createWriteQueue } from '../../runtime/atomicStore';

// 写串行 + tmp+rename：避免并发 updateAgent / ensureDefaultAgent 撕 index.json
const { enqueue, writeAtomic } = createWriteQueue();

type AgentsIndex = { agents: Agent[]; activeId: string | null };

const cache: Map<string, AgentsIndex> = new Map();

/**
 * 存量挡位迁移（只读重构 PRD 决策六）：'strict' 退场→ work（保留写能力、不打断既有工作流）；
 * 更老的 requireApproval 时代无此字段，一并落 work。readonly/work/danger 原样保留。单用户，无迁移公告。
 */
function migrateApprovalMode(stored: string | undefined): Agent['approvalMode'] {
  if (stored === 'readonly' || stored === 'work' || stored === 'danger') return stored;
  return 'work';
}

/** 反序列化时给老数据补 ownerId（其它字段已存在或保留原值） */
function rehydrateAgent(a: Partial<Agent> & { id: string }, ownerId: string): Agent {
  return {
    id: a.id,
    ownerId,
    name: a.name ?? 'Twin',
    homePath: a.homePath ?? '',
    systemPromptAppend: a.systemPromptAppend ?? null,
    approvalMode: migrateApprovalMode(a.approvalMode as string | undefined),
    // enableBash 字段已随 S24 退场（授权改走持久 grants 清单）；老盘残留字段在此不复制、下次写盘自然消失。
    createdAt: a.createdAt ?? Date.now(),
    avatarPath: a.avatarPath ?? null,
  };
}

async function load(ownerId: string): Promise<AgentsIndex> {
  const cached = cache.get(ownerId);
  if (cached) return cached;
  await fs.mkdir(agentsDir(ownerId), { recursive: true });
  const indexPath = agentsIndex(ownerId);
  if (!existsSync(indexPath)) {
    const empty: AgentsIndex = { agents: [], activeId: null };
    cache.set(ownerId, empty);
    return empty;
  }
  try {
    const raw = await fs.readFile(indexPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<AgentsIndex>;
    const agents = Array.isArray(parsed.agents)
      ? parsed.agents.map((a) => rehydrateAgent(a, ownerId))
      : [];
    const next: AgentsIndex = { agents, activeId: parsed.activeId ?? null };
    cache.set(ownerId, next);
    return next;
  } catch {
    const empty: AgentsIndex = { agents: [], activeId: null };
    cache.set(ownerId, empty);
    return empty;
  }
}

async function persistInLock(ownerId: string): Promise<void> {
  const c = cache.get(ownerId);
  if (!c) return;
  await fs.mkdir(userDir(ownerId), { recursive: true });
  await writeAtomic(agentsIndex(ownerId), JSON.stringify(c, null, 2));
}

/**
 * 启动时调用：保证至少有一个 default twin 分身且其家目录就位
 */
export async function ensureDefaultAgent(): Promise<Agent> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const c = await load(ownerId);
    const existing = c.agents.find((a) => a.id === 'twin');
    if (existing) {
      await ensureAgentHome(existing.homePath);
      if (!c.activeId) c.activeId = existing.id;
      await persistInLock(ownerId);
      return existing;
    }
    const homePath = join(agentsDir(ownerId), 'twin', 'home');
    await ensureAgentHome(homePath);
    const agent: Agent = {
      id: 'twin',
      ownerId,
      name: 'Twin',
      homePath,
      systemPromptAppend: null,
      // 新建分身默认「工作」挡：开箱能干活，要只读自己切（PRD 决策六）。
      approvalMode: 'work',
      createdAt: Date.now(),
      avatarPath: null,
    };
    c.agents.push(agent);
    c.activeId = agent.id;
    await persistInLock(ownerId);
    return agent;
  });
}

export async function listAgents(): Promise<{ agents: Agent[]; activeId: string | null }> {
  const ownerId = getCurrentOwnerId();
  const c = await load(ownerId);
  return { agents: c.agents, activeId: c.activeId };
}

export async function getAgent(id: string): Promise<Agent> {
  const ownerId = getCurrentOwnerId();
  const c = await load(ownerId);
  const a = c.agents.find((x) => x.id === id);
  if (!a) {
    const err = new Error(`agent not found: ${id}`) as Error & { code?: string };
    err.code = ErrorCodes.AGENT_NOT_FOUND;
    throw err;
  }
  return a;
}

/**
 * 实时读指定分身当前审批挡位；查不到 agent 回落 fallback（不致 throw 断流）。所有判定点的单一实现——
 * 挡位是安全策略，中途收紧（如改成只读）须立即生效，故一律实时读、不读任务启动时的快照（只读重构）。
 * emitProposal / mcp·plugin·skill 工具 / router 自动执行闸 / claudeCode 的 SDK 写工具闸都经此取挡。
 */
export async function realtimeApprovalModeFor(
  agentId: string,
  fallback: Agent['approvalMode'],
): Promise<Agent['approvalMode']> {
  try {
    return (await getAgent(agentId)).approvalMode;
  } catch {
    return fallback;
  }
}

export async function updateAgent(id: string, patch: Partial<Agent>): Promise<Agent> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const c = await load(ownerId);
    const idx = c.agents.findIndex((a) => a.id === id);
    if (idx === -1) {
      const err = new Error(`agent not found: ${id}`) as Error & { code?: string };
      err.code = ErrorCodes.AGENT_NOT_FOUND;
      throw err;
    }
    // id / ownerId 永远不可改
    c.agents[idx] = { ...c.agents[idx], ...patch, id: c.agents[idx].id, ownerId };
    await persistInLock(ownerId);
    return c.agents[idx];
  });
}

/** 测试用：清缓存让 reload 拿到磁盘最新 */
export function __clearCacheForTest(): void {
  cache.clear();
}

export { LOCAL_USER_ID };
