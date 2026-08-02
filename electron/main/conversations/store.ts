import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatMessage, Conversation, ConversationKind } from '@shared/types';
import type { ConvSearchHit } from '@shared/protocol';
import { ErrorCodes } from '@shared/types';
import { newConversationId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { convDir } from '../runtime/paths';
import { clearToolCacheForConversation } from '../agent/context/persist';
import { clearConvFileState } from '../agent/conversationFileState';
import { deleteSteeringBackups } from '../agent/steeringBackup';
import { clearTurnInflight } from '../agent/turnInflight';
import { clearTodos } from '../agent/todoStore';
import { killBashForConversation } from '../proposals/executeBashProposal';
import { createWriteQueue } from '../runtime/atomicStore';
import { FutureSchemaVersionError, type Migration } from '../runtime/migrateOnRead';
import { migrateFileOnRead } from '../runtime/migrateFile';
import { quarantineCorrupt, noteCorruption } from '../runtime/storageCorruption';

// 串行所有写 + tmp+rename：保证 index.json 不撕裂、jsonl append 与 index 写不交错
const { enqueue, writeAtomic } = createWriteQueue();

// ─── index.json schema 版本（D5 读时迁移的首个 adopter）────────────────────────
// v1（框架引入前）：裸数组 Conversation[]，可能含已退场的 kind='main'。
// v2：versioned envelope { version: 2, conversations: Conversation[] }，全 sub（main 已迁）。
// 老的「每次 loadIndex 把 main 改写成 sub」内联迁移现收敛成 chain[0]（v1→v2）——只对老格式跑一次，
// 写盘即 v2、二次加载零迁移（幂等）。未来 index schema 再演进只需往 chain 追加一个函数。
const CONV_INDEX_BASELINE_VERSION = 1;
const CONV_INDEX_CHAIN: ReadonlyArray<Migration> = [
  // v1 裸数组（可能含 'main'）→ v2 envelope（全 sub）。非数组（脏数据）降级为空，等同原 loadIndex 的
  // `if (!Array.isArray(parsed)) return []` 守卫。'main' 退场前必须先改写成 'sub'，否则下面 KNOWN_KINDS
  // 会把它当未知 kind 丢弃、saveIndex 再物理抹除——历史就丢了。
  (prev) => ({
    version: 2,
    conversations: (Array.isArray(prev) ? prev : []).map((c) =>
      (c as { kind?: string }).kind === 'main' ? { ...(c as object), kind: 'sub' } : c,
    ),
  }),
];
const CONV_INDEX_CURRENT_VERSION = CONV_INDEX_BASELINE_VERSION + CONV_INDEX_CHAIN.length; // = 2
type ConvIndexEnvelope = { version: number; conversations: Array<Partial<Conversation>> };

function agentDir(ownerId: string, agentId: string): string {
  return join(convDir(ownerId), agentId);
}
function indexFile(ownerId: string, agentId: string): string {
  return join(agentDir(ownerId, agentId), 'index.json');
}
function convFile(ownerId: string, agentId: string, convId: string): string {
  return join(agentDir(ownerId, agentId), `${convId}.jsonl`);
}

async function ensureAgentDir(ownerId: string, agentId: string): Promise<void> {
  await fs.mkdir(agentDir(ownerId, agentId), { recursive: true });
}

type LoadedConversation = Partial<Conversation> & {
  id: string;
  agentId: string;
  kind: ConversationKind;
};

/** 反序列化时给老数据补 ownerId；保留 boardTaskId（仅 'taskboard-comment' 用） */
function rehydrateConversation(c: LoadedConversation, ownerId: string): Conversation {
  return {
    id: c.id,
    ownerId,
    agentId: c.agentId,
    kind: c.kind,
    title: c.title ?? '未命名对话',
    sdkSessionId: c.sdkSessionId ?? null,
    createdAt: c.createdAt ?? Date.now(),
    updatedAt: c.updatedAt ?? Date.now(),
    boardTaskId: c.boardTaskId,
    source: c.source, // 旧数据为 undefined（桌面会话也恒 undefined）
    archivedAt: c.archivedAt, // 旧数据为 undefined（=活跃）；必须透传，否则归档状态每次 loadIndex 就丢
    lastSeenAt: c.lastSeenAt, // 同 archivedAt：漏透传则已读水位每次 loadIndex 丢失（通知中心 §5.1）
    foldedBeforeMessageId: c.foldedBeforeMessageId, // 折叠水印（S16）；漏透传则每次 loadIndex 丢、折叠前缀不稳
  };
}

// 运行时 kind 白名单：loadIndex 丢弃未知 kind（防脏数据），但下一次 saveIndex 会把
// 被丢弃的条目从 index.json 物理抹除——漏扩等于静默数据丢失，TS 类型层抓不到。
// 用 Record<ConversationKind, true> 穷举生成：类型加新 kind 而这里漏扩时编译期必报错。
// 注意：'main' 已退场（不在白名单里），存量 main 必须在过滤之前迁移成 sub（见 loadIndex），
// 否则会被当未知 kind 静默抹除——那是数据丢失。
const KNOWN_KINDS: ReadonlyArray<string> = Object.keys({
  sub: true,
  'taskboard-comment': true,
  aside: true,
} satisfies Record<ConversationKind, true>);

async function loadIndex(agentId: string): Promise<Conversation[]> {
  const ownerId = getCurrentOwnerId();
  await ensureAgentDir(ownerId, agentId);
  const path = indexFile(ownerId, agentId);
  if (!existsSync(path)) return [];
  const raw = await fs.readFile(path, 'utf-8').catch(() => null);
  if (raw === null) return []; // 读抖动 / 权限（非内容损坏）——按无数据降级，不隔离健康文件
  try {
    // 读时迁移（D5）：裸数组(v1)→envelope(v2)，main→sub 在 chain[0] 里跑（见 CONV_INDEX_CHAIN）。
    // 待迁移的老格式先落原样副本（S06·G129，runtime/migrateFile）——迁移程序有 bug 时退路仍在。
    const env = await migrateFileOnRead<ConvIndexEnvelope>(
      path,
      raw,
      CONV_INDEX_CHAIN,
      CONV_INDEX_BASELINE_VERSION,
    );
    // 旧程序读到新格式：如实拒绝（§Ver）。抛而不隔离、不覆盖——新数据由更新版程序负责，老程序绝不
    // 按老结构改写、让版本号倒退（migrateOnRead 对 version>current 原样返回，此处据其结果拦截）。
    if (typeof env?.version === 'number' && env.version > CONV_INDEX_CURRENT_VERSION) {
      throw new FutureSchemaVersionError(
        `对话索引版本 ${env.version} 高于本程序支持的 ${CONV_INDEX_CURRENT_VERSION}——拒绝按旧格式改写`,
      );
    }
    // env.conversations 非数组 = 已是 v2 的文件其 conversations 字段被外部写坏；沿用 v1 时代
    // `!Array.isArray → []` 的既有降级（migrateOnRead 只保证 version 结构合法，不保证内容字段）。
    const conversations = Array.isArray(env?.conversations) ? env.conversations : [];
    return conversations
      // 运行时白名单过滤（防脏数据 / 未知 kind）+ 反序列化补字段。main→sub 已在迁移链完成。
      .filter((c): c is LoadedConversation =>
        typeof c.id === 'string' &&
        typeof c.agentId === 'string' &&
        typeof c.kind === 'string' &&
        KNOWN_KINDS.includes(c.kind),
      )
      .map((c) => rehydrateConversation(c, ownerId));
  } catch (e) {
    if (e instanceof FutureSchemaVersionError) throw e; // 未来版本：如实拒绝，绝不落盘覆盖
    // 损坏（JSON 半写坏 / version 字段非法）：隔离原文件保全字节（§Deg「移出读取路径、原样保留」），
    // 再当空读——隔离后下一次 saveIndex 写的是新文件，损坏字节已进 sidecar，不再被物理覆盖丢失。
    await quarantineCorrupt(path, 'conversations/index');
    return [];
  }
}

async function saveIndex(agentId: string, list: Conversation[]): Promise<void> {
  const ownerId = getCurrentOwnerId();
  await ensureAgentDir(ownerId, agentId);
  // 写盘统一带最新 version（D5）：envelope { version, conversations }。老的裸数组文件下次保存即升级到 v2。
  const envelope = { version: CONV_INDEX_CURRENT_VERSION, conversations: list };
  await writeAtomic(indexFile(ownerId, agentId), JSON.stringify(envelope, null, 2));
}

function notFound(convId: string): Error & { code?: string } {
  const err = new Error(`conversation not found: ${convId}`) as Error & { code?: string };
  err.code = ErrorCodes.CONVERSATION_NOT_FOUND;
  return err;
}

/**
 * 列出该 agent 的主列表 conversation（sub），按 updatedAt desc。
 * 主对话已取消——不再有置顶项；时间分段由前端按 updatedAt 切（今天/本周/更早）。
 */
export async function listConversations(agentId: string): Promise<Conversation[]> {
  const list = await loadIndex(agentId);
  return list.filter((c) => c.kind === 'sub').sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 列出该 agent 全部 aside（随手评点归档）对话，updatedAt 倒序。
 * 刻意独立于 listConversations——主列表的 main+sub 口径承载 conv.state 全量同步语义，
 * aside 是按需拉取的另一种语义（aside.list 独立事件），两个查询互不污染。
 */
export async function listAsideConversations(agentId: string): Promise<Conversation[]> {
  const list = await loadIndex(agentId);
  return list.filter((c) => c.kind === 'aside').sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getConversation(agentId: string, convId: string): Promise<Conversation> {
  const list = await loadIndex(agentId);
  const c = list.find((x) => x.id === convId);
  if (!c) throw notFound(convId);
  return c;
}

/**
 * 通用 conversation 创建。kind 'sub' 走原 createSubConversation 行为；
 * kind 'taskboard-comment' 由 taskboard/store.ts:ensureCommentConversation 触发，传 boardTaskId；
 * kind 'aside' 由随手评点 aside.begin 触发。
 */
export async function createConversation(opts: {
  agentId: string;
  title: string;
  kind: ConversationKind;
  boardTaskId?: string;
  /** 三方平台来源（§4.2）；桌面会话不传 */
  source?: Conversation['source'];
}): Promise<Conversation> {
  return enqueue(() => createConversationLocked(opts));
}

/** 建会话内核：仅供已在 enqueue 链上的调用方使用（锁内不得再 enqueue 同链——会等自己死锁）。 */
async function createConversationLocked(opts: {
  agentId: string;
  title: string;
  kind: ConversationKind;
  boardTaskId?: string;
  source?: Conversation['source'];
}): Promise<Conversation> {
  const ownerId = getCurrentOwnerId();
  const list = await loadIndex(opts.agentId);
  const now = Date.now();
  const conv: Conversation = {
    id: newConversationId(),
    ownerId,
    agentId: opts.agentId,
    kind: opts.kind,
    title: opts.title.trim() || '未命名对话',
    sdkSessionId: null,
    createdAt: now,
    updatedAt: now,
    boardTaskId: opts.kind === 'taskboard-comment' ? opts.boardTaskId : undefined,
    source: opts.source,
  };
  list.push(conv);
  await saveIndex(opts.agentId, list);
  return conv;
}

/**
 * 按平台来源查/建会话（§4.2）——平台消息没有预先存在的会话，按 source 在该 agent 名下查；
 * 无则建一条 kind='sub' 带 source（自然进桌面会话列表、认得出来源）。
 *
 * 「查 + 建」整块入 enqueue 锁：调用方已不止 gateway 一家（定时任务渠道落点也走这里，不在
 * gateway 的 per-sessionKey 串行链内），同来源并发到达时锁内查建保证「每渠道一条活跃对话」。
 */
export async function getOrCreateConversation(
  agentId: string,
  source: NonNullable<Conversation['source']>,
  title: string,
): Promise<Conversation> {
  return enqueue(async () => {
    const found = await findConversationBySource(agentId, source); // 顺序读、不递归 enqueue（锁内 IO 有串行代价，index 量级下可接受）
    if (found) return found;
    return createConversationLocked({ agentId, title, kind: 'sub', source });
  });
}

/**
 * 按平台来源只查不建（§4.2）——无则 null。/stop 等「需要既有会话否则无意义」的路径用。
 *
 * 排除已归档对话（S11 · G83 / channels.html#Map）：同一渠道聊天同一时刻只对应一个「活跃（未归档）」
 * 本地对话。归档＝这一段完结，渠道寻址从不解档——已归档的绑定对话查不到，getOrCreateConversation
 * 据此静默新开一段（新消息开新篇、不翻旧账）——渠道消息永远落进新对话，绝不落到已归档对话上。
 * （归档对话的解档＝它内部产生新消息，见 appendMessage；渠道走这条排除路，故不会激活旧段。）
 */
export async function findConversationBySource(
  agentId: string,
  source: NonNullable<Conversation['source']>,
): Promise<Conversation | null> {
  const list = await loadIndex(agentId);
  return (
    list.find(
      (c) =>
        c.archivedAt == null &&
        c.source?.platform === source.platform &&
        c.source?.chatId === source.chatId,
    ) ?? null
  );
}

/** 向后兼容 thin wrapper——保留所有现有 caller */
export async function createSubConversation(agentId: string, title: string): Promise<Conversation> {
  return createConversation({ agentId, title, kind: 'sub' });
}

export async function renameConversation(
  agentId: string,
  convId: string,
  title: string,
): Promise<Conversation> {
  return enqueue(async () => {
    const list = await loadIndex(agentId);
    const idx = list.findIndex((c) => c.id === convId);
    if (idx === -1) throw notFound(convId);
    list[idx] = { ...list[idx], title: title.trim() || list[idx].title, updatedAt: Date.now() };
    await saveIndex(agentId, list);
    return list[idx];
  });
}

/**
 * 原地改写对话 kind（一期用途：aside→sub 转正）。
 * 只动 index.json 里的 kind 与 updatedAt——消息 JSONL、附件一律不碰；
 * updatedAt 刷新让转正后的对话按"刚发生"排进主列表。
 */
export async function rekindConversation(
  agentId: string,
  convId: string,
  toKind: ConversationKind,
): Promise<Conversation> {
  return enqueue(async () => {
    const list = await loadIndex(agentId);
    const idx = list.findIndex((c) => c.id === convId);
    if (idx === -1) throw notFound(convId);
    if (list[idx].kind === 'taskboard-comment') {
      // 评论 conv 转成 sub 后即可被 conv.delete 直接删——task.commentConversationId 会成悬空引用
      const err = new Error('cannot rekind taskboard-comment conversation') as Error & { code?: string };
      err.code = ErrorCodes.BOARD_COMMENT_CONV_PROTECTED;
      throw err;
    }
    list[idx] = { ...list[idx], kind: toKind, updatedAt: Date.now() };
    await saveIndex(agentId, list);
    return list[idx];
  });
}

/**
 * 归档对话（设 archivedAt）——退出时间分桶、收进「已归档」区。供 autoArchiver 定时扫描调用，
 * 也供将来手动归档复用。解档=对话内再产生新消息（appendMessage，用户发言 / Oru 回复）或清空
 * （clearConversation）。渠道消息不落进归档对话（寻址排除，另起一段），故不会激活旧段（S11 · G83）。
 *
 * opts.onlyIfInactiveSince：并发护栏（autoArchiver 用）。扫描"快照命中"到"执行归档"之间隔着
 * await，期间用户可能刚发消息（appendMessage 清 archivedAt + 刷 updatedAt）。入锁后按最新状态
 * 重检：已归档、或 updatedAt 晚于截止点（即又活跃过）→ 跳过返回 null，绝不归档刚活跃的对话。
 * 不传则无条件归档（手动归档语义）。
 */
export async function archiveConversation(
  agentId: string,
  convId: string,
  opts?: { onlyIfInactiveSince?: number },
): Promise<Conversation | null> {
  return enqueue(async () => {
    const list = await loadIndex(agentId);
    const idx = list.findIndex((c) => c.id === convId);
    if (idx === -1) throw notFound(convId);
    const c = list[idx];
    // 入锁重检（承重判断不沿用 await 前的快照）：已归档 / 截止点后又活跃过 → 不归档
    if (
      opts?.onlyIfInactiveSince != null &&
      (c.archivedAt != null || c.updatedAt > opts.onlyIfInactiveSince)
    ) {
      return null;
    }
    list[idx] = { ...c, archivedAt: Date.now() };
    await saveIndex(agentId, list);
    return list[idx];
  });
}

/**
 * 删除对话（taskboard-comment 除外，须经任务级 softDelete）。
 */
export async function deleteConversation(agentId: string, convId: string): Promise<void> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const list = await loadIndex(agentId);
    const idx = list.findIndex((c) => c.id === convId);
    if (idx === -1) return;
    if (list[idx].kind === 'taskboard-comment') {
      // 评论 conv 必须经任务级 softDelete 路径（连同 BoardTask 一起进回收站），
      // 不允许直接通过 conv.delete 路径删——否则 task.commentConversationId 会成悬空引用
      const err = new Error('cannot delete taskboard-comment conversation directly') as Error & { code?: string };
      err.code = ErrorCodes.BOARD_COMMENT_CONV_PROTECTED;
      throw err;
    }
    list.splice(idx, 1);
    await saveIndex(agentId, list);
    const f = convFile(ownerId, agentId, convId);
    if (existsSync(f)) await fs.rename(f, `${f}.bak.${Date.now()}`);
    // v0.4：连同 .tool-cache/ 目录一起清——落盘文件没有引用就没意义
    await clearToolCacheForConversation({ ownerId, agentId, conversationId: convId });
    await deleteSteeringBackups(agentId, convId); // steering 崩溃盘记随对话销毁清——不留孤儿文件、不幽灵交还
    await clearTurnInflight(agentId, convId); // 流式草稿同理随对话销毁清——否则 boot 扫描会把半截补进已删对话
    clearConvFileState(convId); // 防盲覆盖守卫状态随对话销毁清掉
    await clearTodos(ownerId, agentId, convId); // 计划清单随对话销毁清，不留孤儿文件
    killBashForConversation(convId); // kill 该对话的后台 bash 进程组，防泄漏
  });
}

/**
 * 清空对话内容（jsonl 归档备份），并把 sdkSessionId 设回 null（下次发送会开新 SDK session）
 */
export async function clearConversation(agentId: string, convId: string): Promise<Conversation> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const list = await loadIndex(agentId);
    const idx = list.findIndex((c) => c.id === convId);
    if (idx === -1) throw notFound(convId);
    const f = convFile(ownerId, agentId, convId);
    if (existsSync(f)) await fs.rename(f, `${f}.bak.${Date.now()}`);
    // v0.4：归档 JSONL 时一并 rm 工具结果落盘目录（清空后那些 callId 不再有 history 引用）
    await clearToolCacheForConversation({ ownerId, agentId, conversationId: convId });
    clearConvFileState(convId); // 清空对话也清守卫状态——旧认知不延续到清空后
    // 清空 = 把这条对话重置成空白可用对话，计划清单一并清——不清的话下一轮会把清空前的计划贴回去
    await clearTodos(ownerId, agentId, convId);
    killBashForConversation(convId); // 清空对话也 kill 后台 bash 进程组
    // archivedAt 一并清：清空=把这条对话重置成空白可用对话，应回活跃区
    list[idx] = { ...list[idx], sdkSessionId: null, updatedAt: Date.now(), archivedAt: undefined };
    await saveIndex(agentId, list);
    return list[idx];
  });
}

/**
 * 标记已读水位（通知中心 §5.1）——打开对话时写（通知中心 / 对话列表两路都算验收）。
 * 与 updatedAt 正交：appendMessage 只刷 updatedAt 不碰这里，故 Oru 后台跑完后 updatedAt 超过
 * lastSeenAt 即重新未读。不存在的对话静默返回（前端乐观先行，落盘失败不该抛）。
 *
 * 注意：不解档——解档只认「对话内产生新消息」（appendMessage），markSeen（打开 / 通知「忽略」
 * 都经它）只标已读、纯翻看不激活（PM 2026-07-11）。
 */
export async function markConversationSeen(
  agentId: string,
  convId: string,
  seenAt: number,
): Promise<void> {
  return enqueue(async () => {
    const list = await loadIndex(agentId);
    const idx = list.findIndex((c) => c.id === convId);
    if (idx === -1) return;
    // 只升不降（入锁重检）：enqueue 串行后旧 seenAt 出队时磁盘已是更新的水位，用 >= 挡住回退
    if ((list[idx].lastSeenAt ?? 0) >= seenAt) return;
    list[idx] = { ...list[idx], lastSeenAt: seenAt };
    await saveIndex(agentId, list);
  });
}

export async function updateSdkSessionId(
  agentId: string,
  convId: string,
  // null = 作废编号（G112 整理即弃号重灌 / G54 污染重灌）：下次发送 backend 无 resumeId 走重灌。
  sid: string | null,
): Promise<void> {
  return enqueue(async () => {
    const list = await loadIndex(agentId);
    const idx = list.findIndex((c) => c.id === convId);
    if (idx === -1) return;
    if (list[idx].sdkSessionId === sid) return;
    // 作废编号（sid=null）是纯内部视图操作（整理 / 污染重灌），不是用户活动——不碰 updatedAt，
    // 与相邻 updateFoldedBeforeMessageId 同口径，避免污染归档判定与列表 recency。真编号照旧 bump。
    const updatedAt = sid === null ? list[idx].updatedAt : Date.now();
    list[idx] = { ...list[idx], sdkSessionId: sid, updatedAt };
    await saveIndex(agentId, list);
  });
}

/**
 * 更新折叠水印（S16 G63）——整理时刻由 organizeContext 前移；传 undefined 清空（无可折内容）。
 * 不碰 updatedAt：水印是内部视图参数、非用户活动，不应影响归档判定与列表 recency。
 */
export async function updateFoldedBeforeMessageId(
  agentId: string,
  convId: string,
  foldedBeforeMessageId: string | undefined,
): Promise<void> {
  return enqueue(async () => {
    const list = await loadIndex(agentId);
    const idx = list.findIndex((c) => c.id === convId);
    if (idx === -1) return;
    if (list[idx].foldedBeforeMessageId === foldedBeforeMessageId) return;
    list[idx] = { ...list[idx], foldedBeforeMessageId };
    await saveIndex(agentId, list);
  });
}

export async function appendMessage(
  agentId: string,
  convId: string,
  msg: ChatMessage,
): Promise<void> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    await ensureAgentDir(ownerId, agentId);
    await fs.appendFile(convFile(ownerId, agentId, convId), JSON.stringify(msg) + '\n', 'utf-8');
    // 更新对话 updatedAt
    const list = await loadIndex(agentId);
    const idx = list.findIndex((c) => c.id === convId);
    if (idx >= 0) {
      // 归档对话内一产生新消息（用户发言 / Oru 回复）即解档、回到活跃流（PM 2026-07-11）。
      // 与 G83 渠道分段不冲突：渠道寻址排除归档（findConversationBySource），渠道消息永远落进
      // 新对话、不会落到这条已归档对话上——所以只有「用户在桌面打开它继续发言 / Oru 在其中回复」
      // 才会走到这里激活它，纯翻看（只 markSeen、不发消息）不激活。
      list[idx] = { ...list[idx], updatedAt: Date.now(), archivedAt: undefined };
      await saveIndex(agentId, list);
    }
  });
}

/**
 * 删单条消息：重写整个 jsonl（tmp+rename）滤掉目标 id，返回是否真的删了一条。
 * jsonl 平时是追加写，删是唯一需要重写全文的操作——走 writeAtomic 保证不撕裂。
 * 与 appendMessage 同一 enqueue 串行：删与追加不交错。
 * 只按 id 删，不区分 role——role 语义由调用方（评论删除只对用户留言开放入口）把关。
 */
export async function deleteMessage(
  agentId: string,
  convId: string,
  messageId: string,
): Promise<boolean> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const f = convFile(ownerId, agentId, convId);
    if (!existsSync(f)) return false;
    const msgs = await readHistoryForOwner(ownerId, agentId, convId);
    const next = msgs.filter((m) => m.id !== messageId);
    if (next.length === msgs.length) return false; // 没这条
    const body = next.length > 0 ? next.map((m) => JSON.stringify(m)).join('\n') + '\n' : '';
    await writeAtomic(f, body);
    return true;
  });
}

/**
 * 可被 patchMessage 修改的字段——只收 LLM 不可见的展示态字段。
 * 不用 Partial<ChatMessage>：同一份 JSONL 正是 readHistoryForLLM 喂给模型的历史，允许改
 * text/role/toolCalls 等于事后重写模型已见过的内容，会与 sdkSessionId 续传对不上。
 * 后续要加字段须显式扩这个类型（并确认新字段同样 LLM 不可见）。
 */
export type PatchableMessageFields = Pick<ChatMessage, 'memoryRecord'>;

/**
 * 改单条消息的展示态字段：浅合并 patch 后重写整个 jsonl（同 deleteMessage，改单条只能整写）。
 * 与 appendMessage / deleteMessage 同一 enqueue 串行。消息不存在返回 false。
 */
export async function patchMessage(
  agentId: string,
  convId: string,
  messageId: string,
  patch: PatchableMessageFields,
): Promise<boolean> {
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const f = convFile(ownerId, agentId, convId);
    if (!existsSync(f)) return false;
    const msgs = await readHistoryForOwner(ownerId, agentId, convId);
    const idx = msgs.findIndex((m) => m.id === messageId);
    if (idx < 0) return false;
    // 按收窄键显式投影，不整包展开 patch——Pick 只约束字面量，拦不住结构兼容的宽对象
    // （传一整条 ChatMessage 也能过编译），运行时投影才真正兜住「只改展示态字段」。
    // PatchableMessageFields 加字段时须同步在这里加一行投影。
    msgs[idx] = { ...msgs[idx], memoryRecord: patch.memoryRecord };
    const body = msgs.map((m) => JSON.stringify(m)).join('\n') + '\n';
    await writeAtomic(f, body);
    return true;
  });
}

/** 读指定 owner 的对话历史。readHistory 是它在「当前 owner」上的特例。 */
export async function readHistoryForOwner(
  ownerId: string,
  agentId: string,
  convId: string,
): Promise<ChatMessage[]> {
  const f = convFile(ownerId, agentId, convId);
  if (!existsSync(f)) return [];
  // 读抖动 / 权限（非内容损坏）——按无历史降级，与 loadIndex 一致，别让单条对话读失败拖垮整个搜索
  const raw = await fs.readFile(f, 'utf-8').catch(() => null);
  if (raw === null) return [];
  const out: ChatMessage[] = [];
  let skipped = 0;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as Partial<ChatMessage>;
      if (
        typeof obj.id === 'string' &&
        typeof obj.role === 'string' &&
        typeof obj.conversationId === 'string'
      ) {
        // text 字段在类型层是必填，但 JSONL 追加写可能产出缺 text 的半截行（写入中断）。
        // 下游 historyAdapter 对 msg.text 裸调 .trim()，undefined 会炸——这里兜底补空串，
        // 让下游空文本过滤自然跳过这条消息，而非 TypeError 崩溃整轮对话。
        if (typeof obj.text !== 'string') obj.text = '';
        out.push(obj as ChatMessage);
      }
    } catch {
      // 半截行（jsonl 追加写崩溃残留；追加型天然不适用 tmp+rename）——跳过损坏行、留完好消息。
      skipped++;
    }
  }
  if (skipped > 0) {
    // 「丢一条＋不告知」是本章要防的偏差：处置有痕（不静默）。用户可感知的告知面接 S14 信号通道。
    noteCorruption(
      'conversations/history',
      `对话 ${convId} 跳过 ${skipped} 条损坏消息行（追加写半截行；已保留其余完好消息）`,
    );
  }
  return out;
}

export async function readHistory(agentId: string, convId: string): Promise<ChatMessage[]> {
  return readHistoryForOwner(getCurrentOwnerId(), agentId, convId);
}

/**
 * 读取"喂给 LLM 的 history 视图"——最后一个 'context-compressed' marker 置于首位，
 * 其后按物理序放全量历史中「不在任何 marker 的 compressedMessageIds 并集里、且本身不是
 * 旧 marker」的消息（G134：按 id 排除，取代老的「位置切片」）。
 *
 * 为何不再按位置切片：压缩卡经 appendMessage 落在 JSONL 末尾（本轮 user 之后），而压缩时
 * 保留的摘要保留段与白名单消息物理位置在卡之前——位置切片会把它们整段丢出模型视野
 * （盘上不丢、UI 回放完整）。按 id 排除后，被摘要吞掉的消息才排除，保留段/白名单/后续自然留下。
 *
 * marker 唯一性是结构性保证：tail 排除全部 context-compressed kind，故即便某次压缩漏收旧卡 id，
 * 旧卡也因 kind 被排除、绝不漏进视图中段。由此 compress.ts 拿到的 history 恒「marker 至多一个
 * 且在 idx=0」，其入参契约由这条结构成立、不再依赖 compressedMessageIds 的完备性。
 *
 * marker 自身保留在首位，其 contextCompressed.summaryText 由 historyAdapter 翻译成
 * assistant text 喂给 LLM（fallback 模式 summaryText 为空时被 historyAdapter 过滤掉）。
 *
 * 所有"喂 LLM"链路必须用此函数；UI 全量回放和跨对话记忆提炼（dream）走 readHistory。
 */
export async function readHistoryForLLM(agentId: string, convId: string): Promise<ChatMessage[]> {
  const full = await readHistory(agentId, convId);
  let lastMarker: ChatMessage | undefined;
  for (let i = full.length - 1; i >= 0; i -= 1) {
    if (full[i].kind === 'context-compressed') {
      lastMarker = full[i];
      break;
    }
  }
  if (!lastMarker) return full;

  const excludedIds = new Set<string>();
  for (const m of full) {
    if (m.kind === 'context-compressed') {
      for (const id of m.contextCompressed?.compressedMessageIds ?? []) excludedIds.add(id);
    }
  }
  const tail = full.filter(
    (m) => m !== lastMarker && m.kind !== 'context-compressed' && !excludedIds.has(m.id),
  );
  return [lastMarker, ...tail];
}

// 搜索跳过的非纯文本消息 kind：卡片类（text 空或非用户语义），搜了只会糊结果。
const SEARCH_SKIP_KINDS: ReadonlySet<string> = new Set([
  'proposal',
  'task-report',
  'context-compressed',
  'turn-terminator',
]);

/**
 * 全局搜索：该 agent 的全部对话（sub + 随手评点 aside），标题 + 消息正文一起搜
 * （大小写不敏感 includes）。主对话取消后，搜索是删掉置顶后唯一的"找回"通道——所以
 * 连 aside 一起搜，让随手评点也搜得到。
 *
 * 实时全扫，不建索引：单 agent 规模量级，索引的失效维护成本此刻不划算（第一性：先满足正确，
 * 量级真痛了再加索引，零成本）。命中消息返回全文，关键词上下文切片 + 高亮交前端（纯展示逻辑）。
 */
export async function searchConversations(
  agentId: string,
  query: string,
): Promise<ConvSearchHit[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  // 一次 loadIndex 取全量再分流——不走 listConversations + listAsideConversations 两次读：
  // 两次读之间若有 rekind（aside→sub）会让同一对话两边各出现一次，单次读消灭这个脏读窗口。
  const all = await loadIndex(agentId);
  const byRecency = (a: Conversation, b: Conversation) => b.updatedAt - a.updatedAt;
  const convs = [
    ...all.filter((c) => c.kind === 'sub').sort(byRecency),
    ...all.filter((c) => c.kind === 'aside').sort(byRecency),
  ];
  const groups: ConvSearchHit[] = [];
  for (const conv of convs) {
    const titleHit = conv.title.toLowerCase().includes(q);
    const history = await readHistory(agentId, conv.id);
    const messages = history
      .filter(
        (m) =>
          (m.role === 'user' || m.role === 'assistant') &&
          !SEARCH_SKIP_KINDS.has(m.kind ?? '') &&
          m.text.toLowerCase().includes(q),
      )
      .map((m) => ({ id: m.id, role: m.role, text: m.text }));
    if (titleHit || messages.length > 0) groups.push({ conversation: conv, titleHit, messages });
  }
  return groups;
}

