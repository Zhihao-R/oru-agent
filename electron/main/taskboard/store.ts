/**
 * 任务 BoardTask 持久化 store。
 *
 * 落盘布局：
 *   ~/.oru/users/<ownerId>/taskboard/index.json     # BoardTaskMeta[]，含已删除
 *   ~/.oru/users/<ownerId>/taskboard/tasks/<id>.json  # 单任务（含 description）
 *
 * 写并发：模块内 promise-queue 串行所有写，避免 index.json 撕裂。
 * 写原子化：tmp + rename，断电至少不破坏已有数据。
 *
 * 多用户：所有接口走 getCurrentOwnerId()，本期单用户 'local-user'。
 *
 * 事件总线：store 自己只 emit taskboardEvents（upsert/delete/restore/
 *   commentConvCreated/requestAbort）；transport 层（wireBroadcast）订阅后转 broadcast。
 *   调用方（router）不重复 broadcast。
 *
 *   本期只切了 taskboard → ws/agent 这一条反向依赖；router 仍有两处直接
 *   import abortConversation——agent/runner 拆事件层是单独 plan。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import type {
  BoardActorId,
  BoardTask,
  BoardTaskFilters,
  BoardTaskMeta,
  BoardTaskStatus,
  ChatAttachment,
  Conversation,
} from '@shared/types';
import { ErrorCodes } from '@shared/types';
import { newBoardTaskId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import {
  taskboardIndexPath,
  taskboardTaskPath,
  taskboardTasksSubdir,
} from '../runtime/paths';
import { ensureDefaultAgent } from '../agent/store/agents';
import { createConversation, getConversation } from '../conversations/store';
import { createWriteQueue } from '../runtime/atomicStore';
import { taskboardEvents } from './events';

// ─── 写入串行 + 原子化（共用 runtime/atomicStore） ───
const { enqueue, writeAtomic } = createWriteQueue();

// ─── 内部 helper ───
async function ensureTaskboardDir(ownerId: string): Promise<void> {
  await fs.mkdir(taskboardTasksSubdir(ownerId), { recursive: true });
}

async function loadIndex(ownerId: string): Promise<BoardTaskMeta[]> {
  await ensureTaskboardDir(ownerId);
  const path = taskboardIndexPath(ownerId);
  if (!existsSync(path)) return [];
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as BoardTaskMeta[];
  } catch (e) {
    console.warn('[taskboard] index.json 解析失败，按空处理:', e);
    return [];
  }
}

async function writeIndex(ownerId: string, metas: BoardTaskMeta[]): Promise<void> {
  await ensureTaskboardDir(ownerId);
  await writeAtomic(taskboardIndexPath(ownerId), JSON.stringify(metas, null, 2));
}

/** 单任务 JSON 也走 tmp+rename，避免与 listTasks 的 q 描述读路径撕裂 + 断电安全 */
async function writeTask(ownerId: string, t: BoardTask): Promise<void> {
  await ensureTaskboardDir(ownerId);
  await writeAtomic(taskboardTaskPath(ownerId, t.id), JSON.stringify(t, null, 2));
}

/** 把 BoardTask 转成 BoardTaskMeta（剥掉 description）。export 给 router 用——
 *  router 在 reply create.result 时需要把 store 返回的 BoardTask 转 meta。 */
export function toMeta(t: BoardTask): BoardTaskMeta {
  // 显式构建——防止 description / attachments 泄漏到 meta（都只在详情面板展示，不进列表行）
  const { description: _description, attachments: _attachments, ...rest } = t;
  return rest;
}

function makeError(code: keyof typeof ErrorCodes, message: string): Error & { code: string } {
  const e = new Error(message) as Error & { code: string };
  e.code = ErrorCodes[code];
  return e;
}

// ─── 公开接口 ───

export type CreateTaskInput = {
  title: string;
  description?: string;
  status?: BoardTaskStatus;
  assignee?: BoardActorId;
  projectTag?: string;
};

export async function createTask(input: CreateTaskInput, by: BoardActorId): Promise<BoardTask> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const now = Date.now();
    const t: BoardTask = {
      id: newBoardTaskId(),
      ownerId,
      title: input.title,
      description: input.description,
      status: input.status ?? '待办',
      assignee: input.assignee ?? by,
      projectTag: input.projectTag,
      createdAt: now,
      updatedAt: now,
      commentCount: 0,
    };
    // 写单文件（tmp+rename）
    await writeTask(ownerId, t);
    // 写 index
    const idx = await loadIndex(ownerId);
    idx.push(toMeta(t));
    await writeIndex(ownerId, idx);
    taskboardEvents.emit('upsert', toMeta(t));
    return t;
  });
}

export async function getTask(id: string): Promise<BoardTask | null> {
  const ownerId = getCurrentOwnerId();
  const path = taskboardTaskPath(ownerId, id);
  if (!existsSync(path)) return null;
  try {
    const raw = await fs.readFile(path, 'utf-8');
    return JSON.parse(raw) as BoardTask;
  } catch (e) {
    console.warn(`[taskboard] task ${id} 解析失败:`, e);
    return null;
  }
}

const ALLOWED_PATCH_FIELDS = ['title', 'description', 'status', 'assignee', 'projectTag'] as const;
type UpdatePatchField = typeof ALLOWED_PATCH_FIELDS[number];
export type UpdatePatch = Partial<Pick<BoardTask, UpdatePatchField>>;

export async function updateTask(id: string, patch: UpdatePatch): Promise<BoardTask> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const t = await getTask(id);
    if (!t) throw makeError('BOARD_TASK_NOT_FOUND', `任务 ${id} 不存在`);
    if (t.deletedAt) throw makeError('BOARD_TASK_DELETED', `任务 ${id} 已在回收站`);

    const merged: BoardTask = { ...t };
    for (const k of ALLOWED_PATCH_FIELDS) {
      if (k in patch) (merged as any)[k] = (patch as any)[k];
    }
    merged.updatedAt = Date.now();

    // completedAt 维护：只在 status 跨入/跨出 '已完成' 时变化
    if ('status' in patch && patch.status !== undefined && patch.status !== t.status) {
      if (patch.status === '已完成') merged.completedAt = Date.now();
      else if (t.status === '已完成') merged.completedAt = undefined;
    }

    await writeTask(ownerId, merged);
    const idx = await loadIndex(ownerId);
    const i = idx.findIndex(m => m.id === id);
    if (i >= 0) idx[i] = toMeta(merged);
    await writeIndex(ownerId, idx);
    taskboardEvents.emit('upsert', toMeta(merged));
    return merged;
  });
}

/**
 * 增量增删任务图片附件（描述插图；创建落图 / 详情增删都走它）。
 * addSaved 已是落盘后的 ChatAttachment[]（saveTaskboardAttachments 产出）；removeRelPaths 是要删的既有 relPath。
 * **锁内基于最新盘合成**：删 removeRelPaths + 追加 addSaved——并发两次增删各读最新盘、各自组合，不互相覆盖
 * （不接收「渲染端算好的全集」覆盖写，那会因客户端快照过期丢图）。创建落图是 removeRelPaths=[] 的特例。
 * 与 updateTask 分开：图片不在 ALLOWED_PATCH_FIELDS（不让通用 patch 通道碰图）。
 */
export async function applyAttachmentDelta(
  taskId: string,
  addSaved: ChatAttachment[],
  removeRelPaths: string[],
): Promise<BoardTask> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const t = await getTask(taskId);
    if (!t) throw makeError('BOARD_TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
    if (t.deletedAt) throw makeError('BOARD_TASK_DELETED', `任务 ${taskId} 已在回收站`);
    const removeSet = new Set(removeRelPaths);
    const kept = (t.attachments ?? []).filter((a) => !removeSet.has(a.relPath));
    // 落盘不带 displayUrl（渲染端 hydrate 出来的 oru-board-img:// 是瞬态视图，不进盘）
    const persistedAdd = addSaved.map(({ displayUrl: _displayUrl, ...rest }) => rest);
    const next = [...kept, ...persistedAdd];
    const merged: BoardTask = {
      ...t,
      attachments: next.length > 0 ? next : undefined,
      updatedAt: Date.now(),
    };
    await writeTask(ownerId, merged);
    const idx = await loadIndex(ownerId);
    const i = idx.findIndex((m) => m.id === taskId);
    if (i >= 0) idx[i] = toMeta(merged);
    await writeIndex(ownerId, idx);
    taskboardEvents.emit('upsert', toMeta(merged));
    return merged;
  });
}

export async function softDeleteTask(id: string, by: BoardActorId): Promise<BoardTask> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const t = await getTask(id);
    if (!t) throw makeError('BOARD_TASK_NOT_FOUND', `任务 ${id} 不存在`);
    if (t.deletedAt) throw makeError('BOARD_TASK_DELETED', `任务 ${id} 已在回收站`);
    const now = Date.now();
    const merged: BoardTask = {
      ...t,
      deletedAt: now,
      deletedBy: by,
      preDeleteStatus: t.status,
      updatedAt: now,
    };
    await writeTask(ownerId, merged);
    const idx = await loadIndex(ownerId);
    const i = idx.findIndex(m => m.id === id);
    if (i >= 0) idx[i] = toMeta(merged);
    await writeIndex(ownerId, idx);
    // 评论 conv 中止：若 task 关联了评论 conv 且当前有 Oru 调用在跑，触发中止
    //  P0 阶段 commentConversationId 永远 undefined，本分支不进入；
    //  P0.5 评论功能上线后才有副作用。
    if (t.commentConversationId) {
      try {
        const agent = await ensureDefaultAgent();
        taskboardEvents.emit('requestAbort', {
          agentId: agent.id,
          conversationId: t.commentConversationId,
        });
      } catch (e) {
        // emit 本身不会 throw；catch 仅防 ensureDefaultAgent 失败——不阻断删除
        console.warn(`[taskboard] softDeleteTask: requestAbort failed for ${id}:`, e);
      }
    }
    taskboardEvents.emit('delete', id);
    return merged;
  });
}

export async function restoreTask(id: string): Promise<BoardTask> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const t = await getTask(id);
    if (!t) throw makeError('BOARD_TASK_NOT_FOUND', `任务 ${id} 不存在`);
    if (!t.deletedAt) {
      // 已经在主视图，幂等：不报错也不动盘、**不 broadcast**——
      //   前端调 restore 后若要 UI 同步，应在已知任务在主视图时跳过等 taskRestore 事件。
      return t;
    }
    const merged: BoardTask = {
      ...t,
      deletedAt: undefined,
      deletedBy: undefined,
      preDeleteStatus: undefined,
      updatedAt: Date.now(),
    };
    await writeTask(ownerId, merged);
    const idx = await loadIndex(ownerId);
    const i = idx.findIndex(m => m.id === id);
    if (i >= 0) idx[i] = toMeta(merged);
    await writeIndex(ownerId, idx);
    taskboardEvents.emit('restore', toMeta(merged));
    return merged;
  });
}

// ─── 评论辅助（PR-D1）──────────────────────────────────────────

/**
 * 评论 conv 落消息后调用：commentCount +1 + broadcast taskUpsert。
 * 调用方（PR-D2 router）保证一次 appendMessage 一次调用。
 * task 不存在 / 已删除 → 静默 log（append 路径不应因计数失败而崩）。
 */
export async function incrementCommentCount(taskId: string): Promise<void> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const t = await getTask(taskId);
    if (!t) {
      console.warn(`[taskboard] incrementCommentCount: task ${taskId} not found`);
      return;
    }
    if (t.deletedAt) {
      console.warn(`[taskboard] incrementCommentCount: task ${taskId} already deleted`);
      return;
    }
    const merged: BoardTask = {
      ...t,
      commentCount: (t.commentCount ?? 0) + 1,
      updatedAt: Date.now(),
    };
    await writeTask(ownerId, merged);
    const idx = await loadIndex(ownerId);
    const i = idx.findIndex(m => m.id === taskId);
    if (i >= 0) idx[i] = toMeta(merged);
    await writeIndex(ownerId, idx);
    taskboardEvents.emit('upsert', toMeta(merged));
  });
}

/**
 * 删一条评论后调用：commentCount -1（floor 0）+ broadcast taskUpsert。
 * 与 incrementCommentCount 对称；task 不存在 / 已删除 → 静默 log（删除路径不因计数失败而崩）。
 */
export async function decrementCommentCount(taskId: string): Promise<void> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const t = await getTask(taskId);
    if (!t) {
      console.warn(`[taskboard] decrementCommentCount: task ${taskId} not found`);
      return;
    }
    if (t.deletedAt) {
      console.warn(`[taskboard] decrementCommentCount: task ${taskId} already deleted`);
      return;
    }
    const merged: BoardTask = {
      ...t,
      commentCount: Math.max(0, (t.commentCount ?? 0) - 1),
      updatedAt: Date.now(),
    };
    await writeTask(ownerId, merged);
    const idx = await loadIndex(ownerId);
    const i = idx.findIndex((m) => m.id === taskId);
    if (i >= 0) idx[i] = toMeta(merged);
    await writeIndex(ownerId, idx);
    taskboardEvents.emit('upsert', toMeta(merged));
  });
}

/**
 * 懒创建评论 conv：
 *   1. task 不存在 → BOARD_TASK_NOT_FOUND
 *   2. task 已删除 → BOARD_TASK_DELETED
 *   3. task.commentConversationId 已存在且对应 conv 健在 → 返回
 *   4. 否则：createConversation('taskboard-comment', boardTaskId) + 写回 BoardTask + 广播 commentConvCreated
 *
 * 锁策略：检查 + 创建 + attach + 广播 全部在同一 enqueue 里串行；
 * 不嵌套调用 attachCommentConversation 等会再 enqueue 的函数（会死锁——
 * enqueue 把新的 f 排在 writeChain 之后，writeChain 当前正是这次调用本身）。
 *
 * 并发场景：两次同时 ensure 同一 task → 锁内重新读，第二次会发现 commentConversationId
 * 已存在并直接返回；不会创出两个 conv。
 */
export async function ensureCommentConversation(
  taskId: string,
): Promise<{ conv: Conversation; task: BoardTask }> {
  // 锁外快路径：已存在且健在 → 重读一次 fresh task 再返回
  // （第一次读到的 t0 可能在 getConversation 期间被并发的 updateTask 改了
  //  projectTag 等——caller 用 task.projectTag 解析项目时可能拿到过期值）
  const t0 = await getTask(taskId);
  if (!t0) throw makeError('BOARD_TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
  if (t0.deletedAt) throw makeError('BOARD_TASK_DELETED', `任务 ${taskId} 已在回收站`);
  if (t0.commentConversationId) {
    const agent = await ensureDefaultAgent();
    try {
      const conv = await getConversation(agent.id, t0.commentConversationId);
      // 重读 fresh task（getConversation 期间可能字段被改）
      const freshTask = await getTask(taskId);
      if (!freshTask) throw makeError('BOARD_TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
      if (freshTask.deletedAt) throw makeError('BOARD_TASK_DELETED', `任务 ${taskId} 已在回收站`);
      return { conv, task: freshTask };
    } catch (e) {
      // commentConversationId 指向不存在的 conv → 进锁路径重建
      // 但 BOARD_TASK_* 错误不应吞——继续抛
      const code = (e as { code?: string }).code;
      if (code === ErrorCodes.BOARD_TASK_NOT_FOUND || code === ErrorCodes.BOARD_TASK_DELETED) {
        throw e;
      }
    }
  }
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const t = await getTask(taskId);
    if (!t) throw makeError('BOARD_TASK_NOT_FOUND', `任务 ${taskId} 不存在`);
    if (t.deletedAt) throw makeError('BOARD_TASK_DELETED', `任务 ${taskId} 已在回收站`);

    const agent = await ensureDefaultAgent();

    // 锁内重检：若已存在且健在（被并发的 ensure 创出来了）→ 直接返回
    if (t.commentConversationId) {
      try {
        const conv = await getConversation(agent.id, t.commentConversationId);
        return { conv, task: t };
      } catch {
        // 仍悬空 → 重建
      }
    }

    const conv = await createConversation({
      agentId: agent.id,
      title: `评论 · ${t.title}`,
      kind: 'taskboard-comment',
      boardTaskId: taskId,
    });

    // attach：写回 BoardTask.commentConversationId。
    // 不刷 updatedAt——这是首次打开详情时的内部记账，不是用户对任务的修改；
    // 列表按 updatedAt 排序，刷了会让「点开看一眼」的任务跳到列表顶部。
    const merged: BoardTask = {
      ...t,
      commentConversationId: conv.id,
    };
    await writeTask(ownerId, merged);
    const idx = await loadIndex(ownerId);
    const i = idx.findIndex(m => m.id === taskId);
    if (i >= 0) idx[i] = toMeta(merged);
    await writeIndex(ownerId, idx);

    // 发两条：upsert（commentConversationId 写入）+ commentConvCreated（前端 byId 注册）
    taskboardEvents.emit('upsert', toMeta(merged));
    taskboardEvents.emit('commentConvCreated', { task: toMeta(merged), conversation: conv });

    return { conv, task: merged };
  });
}

// ─── 列表查询（含 q 搜描述）─────────────────────────────────

export async function listTasks(filters: BoardTaskFilters = {}): Promise<BoardTaskMeta[]> {
  const ownerId = getCurrentOwnerId();
  const all = await loadIndex(ownerId);
  // 第一阶段：可从 meta 直接判断的过滤
  const candidates = all.filter(m => {
    if (!filters.includeDeleted && m.deletedAt) return false;
    if (filters.status && filters.status.length > 0 && !filters.status.includes(m.status)) return false;
    if (filters.projectTag && m.projectTag !== filters.projectTag) return false;
    if (filters.assignee && m.assignee !== filters.assignee) return false;
    return true;
  });
  // 第二阶段：q 关键词搜——先标题粗筛，再读单文件查 description
  if (!filters.q) return candidates;
  const q = filters.q.toLowerCase();
  const titleHits = candidates.filter(m => m.title.toLowerCase().includes(q));
  const titleHitIds = new Set(titleHits.map(m => m.id));
  const descHits: BoardTaskMeta[] = [];
  for (const m of candidates) {
    if (titleHitIds.has(m.id)) continue;
    const t = await getTask(m.id);
    if (t?.description?.toLowerCase().includes(q)) descHits.push(m);
  }
  return [...titleHits, ...descHits];
}
