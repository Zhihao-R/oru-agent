/**
 * Subagent task 持久化
 * - meta: ~/.oru/users/<userId>/tasks/<taskId>.json
 * - 流式事件: ~/.oru/users/<userId>/tasks/<taskId>.jsonl（一行一个 event）
 * - 中途追问: ~/.oru/users/<userId>/tasks/<taskId>.questions.json（数组）
 *
 * v1 字段扩展（profileId / endTag / affectedPaths / commitsCreated / announcedAt /
 *   featureBranch / ownerId）老数据缺失时反序列化给默认值，避免崩溃
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SubagentTask, TaskQuestion } from '@shared/types';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { tasksDir } from '../runtime/paths';
import { createWriteQueue } from '../runtime/atomicStore';
import { makeVersionedCodec } from '../runtime/versionedRecord';
import { shorten } from '@shared/agent/toolActivity';
import { normalizeToolName } from '@shared/agent/toolName';

// 串行所有写 + tmp+rename 原子写——避免 read-modify-write 撕裂、断电安全
const { enqueue, writeAtomic } = createWriteQueue();

// ─── 格式版本（S06·G128）─────────────────────────────────────────
// v1（无 version）：裸 SubagentTask；v2：envelope { version, task }。字段级演进照旧走
// hydrate 补默认，版本号管「改语义/删字段」级的结构演进与备份还原判读。jsonl 流文件与
// questions.json 是 meta 的附属，不各自带版本。封套原语共享自 runtime/versionedRecord。
const codec = makeVersionedCodec<SubagentTask>({
  baselineVersion: 1,
  chain: [(prev) => ({ version: 2, task: prev })],
  field: 'task',
  label: 'tasks',
});

/**
 * 读一个任务 meta 文件到裸 task（读时迁移 + 迁移前原样副本）。
 * 未来版本 → null（跳过不读、绝不按旧格式改写让版本倒退）；JSON 损坏照旧抛给调用方兜。
 */
async function readTaskFile(path: string): Promise<Partial<SubagentTask> | null> {
  const rawText = await fs.readFile(path, 'utf-8');
  return codec.read(path, rawText);
}

async function ensureDir(): Promise<void> {
  await fs.mkdir(tasksDir(getCurrentOwnerId()), { recursive: true });
}

function metaFile(id: string): string {
  return join(tasksDir(getCurrentOwnerId()), `${id}.json`);
}

function streamFile(id: string): string {
  return join(tasksDir(getCurrentOwnerId()), `${id}.jsonl`);
}

function questionsFile(id: string): string {
  return join(tasksDir(getCurrentOwnerId()), `${id}.questions.json`);
}

/**
 * 给老数据做字段填充。任何在 v1 之后扩展的字段都在这里写默认值
 */
function hydrate(raw: Partial<SubagentTask> & { id: string }, ownerId: string): SubagentTask {
  return {
    id: raw.id,
    ownerId: raw.ownerId ?? ownerId,
    agentId: raw.agentId ?? 'twin',
    conversationId: raw.conversationId ?? '',
    proposalId: raw.proposalId ?? '',
    proposalTitle: raw.proposalTitle ?? '(无标题)',
    targetProjectId: raw.targetProjectId ?? null,
    status: raw.status ?? 'pending',
    baselineCommit: raw.baselineCommit ?? null,
    summary: raw.summary ?? null,
    errorMessage: raw.errorMessage ?? null,
    startedAt: raw.startedAt ?? Date.now(),
    finishedAt: raw.finishedAt ?? null,
    profileId: raw.profileId ?? 'project-coder',
    endTag: raw.endTag ?? null,
    affectedPaths: raw.affectedPaths ?? [],
    commitsCreated: raw.commitsCreated ?? [],
    announcedAt: raw.announcedAt ?? null,
    featureBranch: raw.featureBranch ?? null,
  };
}

/** 测试 hook：smoke_hydrate 测试用，外面不要直接调 */
export function __hydrateForTest(raw: Partial<SubagentTask> & { id: string }): SubagentTask {
  return hydrate(raw, getCurrentOwnerId());
}

export async function createTask(task: SubagentTask): Promise<void> {
  return enqueue(async () => {
    await ensureDir();
    await writeAtomic(metaFile(task.id), codec.serialize(task));
  });
}

/**
 * 锁内 RMW：读当前值 → merge patch → 原子写，整块在 enqueue 内，绝不锁外读。
 * status / announcedAt 等所有字段更新都收敛到这一条，避免"只锁 write、读在外面"丢并发更新。
 */
export async function patchTask(
  id: string,
  patch: Partial<SubagentTask>,
): Promise<SubagentTask | null> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const f = metaFile(id);
    if (!existsSync(f)) return null;
    try {
      const raw = await readTaskFile(f);
      if (!raw) return null; // 未来版本：不读不写（版本不倒退）
      const cur = hydrate({ ...raw, id }, ownerId);
      const next: SubagentTask = { ...cur, ...patch, id: cur.id };
      await writeAtomic(f, codec.serialize(next));
      return next;
    } catch {
      return null;
    }
  });
}

export async function updateTaskStatus(
  id: string,
  status: SubagentTask['status'],
  patch: Partial<SubagentTask> = {},
): Promise<SubagentTask | null> {
  return patchTask(id, { ...patch, status });
}

export async function appendTaskEvent(id: string, event: unknown): Promise<void> {
  // jsonl append 也进 queue，避免与 metaFile 写竞争
  return enqueue(async () => {
    await ensureDir();
    await fs.appendFile(streamFile(id), JSON.stringify(event) + '\n', 'utf-8');
  });
}

export async function getTask(id: string): Promise<SubagentTask | null> {
  const ownerId = getCurrentOwnerId();
  const f = metaFile(id);
  if (!existsSync(f)) return null;
  try {
    const raw = await readTaskFile(f);
    return raw ? hydrate({ ...raw, id }, ownerId) : null;
  } catch {
    return null;
  }
}

/** 列该 owner 全部 task（不过滤 conversation）——启动扫描悬空任务（G18）用。 */
export async function listAllTasks(): Promise<SubagentTask[]> {
  const ownerId = getCurrentOwnerId();
  await ensureDir();
  const dir = tasksDir(ownerId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SubagentTask[] = [];
  for (const f of entries) {
    if (!f.endsWith('.json') || f.endsWith('.questions.json')) continue;
    try {
      const parsed = await readTaskFile(join(dir, f));
      if (!parsed?.id) continue;
      out.push(hydrate({ ...parsed, id: parsed.id }, ownerId));
    } catch {
      // 单个文件解析失败不阻断
    }
  }
  return out;
}

/** 列指定 conversation 下所有 task；用于 taskAnnouncer / hooks 注入未播报 task */
export async function listTasksForConversation(conversationId: string): Promise<SubagentTask[]> {
  const all = await listAllTasks();
  return all.filter((t) => t.conversationId === conversationId);
}

// 流文件尾部读取上限：write_file 等大入参事件单行可能上 MB，全读会爆内存——
// 只读尾部这么多字节，够拿到「最近一次活动」即可。
const PROGRESS_TAIL_BYTES = 64 * 1024;

/**
 * 取某个 task「最近一次活动」的简短描述——给主对话的 check_subagent_progress 工具回答
 * 「它现在在干啥」。只读流文件尾部（见 PROGRESS_TAIL_BYTES），从尾向前扫第一条可读的
 * assistant_text / tool_use 事件；解析不出就返回 null，调用方退化成纯状态。
 */
export async function getLastProgress(id: string): Promise<string | null> {
  const f = streamFile(id);
  if (!existsSync(f)) return null;
  let text: string;
  let truncated: boolean;
  try {
    const fh = await fs.open(f, 'r');
    try {
      const { size } = await fh.stat();
      const start = Math.max(0, size - PROGRESS_TAIL_BYTES);
      const len = size - start;
      if (len <= 0) return null;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, start);
      text = buf.toString('utf-8');
      truncated = start > 0; // 从中间切起，首行可能是半截
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
  const lines = text.split('\n').filter((l) => l.trim());
  if (truncated && lines.length > 0) lines.shift();
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const { event } = JSON.parse(lines[i]) as {
        event?: { type?: string; text?: string; name?: string };
      };
      if (!event) continue;
      if (event.type === 'assistant_text' && event.text?.trim()) return shorten(event.text);
      // claude-code 事件名带 mcp__oru__ 前缀——文案剥前缀，不给用户露内部代号
      if (event.type === 'tool_use' && event.name) return `调用工具：${normalizeToolName(event.name)}`;
    } catch {
      // 坏行跳过，继续向前
    }
  }
  return null;
}

// ─── 中途追问历史 ────────────────────────────────────────────────────

async function readQuestions(id: string): Promise<TaskQuestion[]> {
  const f = questionsFile(id);
  if (!existsSync(f)) return [];
  try {
    const raw = await fs.readFile(f, 'utf-8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as TaskQuestion[]) : [];
  } catch {
    return [];
  }
}

async function writeQuestions(id: string, list: TaskQuestion[]): Promise<void> {
  await ensureDir();
  await writeAtomic(questionsFile(id), JSON.stringify(list, null, 2));
}

export async function appendQuestion(id: string, q: TaskQuestion): Promise<void> {
  return enqueue(async () => {
    const list = await readQuestions(id);
    list.push(q);
    await writeQuestions(id, list);
  });
}

export async function updateQuestion(
  id: string,
  questionId: string,
  patch: Partial<TaskQuestion>,
): Promise<TaskQuestion | null> {
  return enqueue(async () => {
    const list = await readQuestions(id);
    const idx = list.findIndex((q) => q.id === questionId);
    if (idx < 0) return null;
    const next: TaskQuestion = { ...list[idx], ...patch };
    list[idx] = next;
    await writeQuestions(id, list);
    return next;
  });
}

export async function getQuestions(id: string): Promise<TaskQuestion[]> {
  return readQuestions(id);
}

// ─── 任务级别的状态便捷方法 ──────────────────────────────────────────

export async function markAnnounced(id: string): Promise<void> {
  // 纯标记：只打 announcedAt，status 由锁内重读保留——绝不锁外读 status 再写回，
  // 否则与并发的终态写（如 cancel 时 catch 的 status='failed'）会互相覆盖。
  await patchTask(id, { announcedAt: Date.now() });
}

