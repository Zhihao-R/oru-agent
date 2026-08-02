/**
 * conversationFileState —— 防盲覆盖守卫的模块级 store（决策 2/4，B 方案支持部分读）。
 *
 * 为什么是模块级单例：守卫状态被三方读写——read_file（读后写）、写类工具 execute（emit 前预检）、
 * 执行器（落盘前复检 + 落盘后回写）。执行器无 ToolContext，故做成按 conversationId 分桶的
 * 模块级 store（对齐 taskboard/deck store）。
 *
 * 守卫独立于审批（决策 2）：覆盖/编辑已存在文件前，必须本对话内 read 过且未被外部改动。
 * 无审批态体验：撞守卫 → 自动先 read → 再写，永远基于认知。
 *
 * B 方案核心：区分「整读过」(isPartialView=false) 和「只看过一段」(isPartialView=true)——
 * 否则只读了大文件第 500 行就去覆盖整文件，守卫会误放行（决策 4）。
 */
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { readWithMeta } from '../fs/safeWrite';
import { normalizeQuotes, findActualString } from '../fs/editMatch';

export type FileState = {
  mtime: number; // 已 Math.floor
  content: string; // 本次读到的内容（可能是部分）
  offset?: number; // 部分读起始行（整读时 undefined）
  limit?: number; // 部分读行数（整读时 undefined）
  isPartialView: boolean; // true=只看过一段，不足以支撑整文件覆盖
};

export type GuardOp = 'overwrite' | 'edit';
// S02 · G88 恢复整体覆盖的基线判定（理想页 G3：「全文仍是读到的那一版」才可整篇覆盖）：
// 读后被外部改动 → 'baseline-moved'，按「目标已移动」退回重读——当年为防「真阳性风暴」去掉
// 'changed' 的放宽是协同编辑落地前的旧决策，已被理想架构推翻；「不丢」仍由 overwrite-guard 兜底，
// 「不错」从此靠基线（锁外此处早失败，锁内 commitWorkfileWrite 的 baseline 才作数）。
// edit 判「目标段是否仍能定位」：定位不到 → 'target-moved'（走 recovery）。
export type GuardResult =
  | 'ok'
  | 'never-read'
  | 'partial-only'
  | 'out-of-view'
  | 'target-moved'
  | 'baseline-moved';

// ── 上下文代际：压缩/折叠发生过几次 ─────────────────────────────────────
// read_file 的 dedup（同文件同范围 mtime 未变 → 只回一句「参考上次读取的内容」）默认
// 「上次读到的内容还在模型上下文里」。压缩或折叠之后这个前提不成立，dedup 自己察觉不到——
// 模型既拿不到内容、又没有强制重读的口子，实测会连环 edit 失配。
//
// 判据本该是「那条 read 落在哪条消息上、该消息是否已被压缩掉」，但落不了地：ToolContext 只有
// conversationId，拿不到会话历史或折叠水印；readFile 执行时也不知道自己会被写进哪条消息
// （那是 runner 在工具执行完之后才组装的）。代际计数器绕开这条管线缺口，判据强度一样——
// 整理发生过，上次读到的内容就当作已离场。
// 字段收在本模块内部（StoredFileState），recordRead / afterWrite 的对外签名不变。
const generations = new Map<string, number>();

type StoredFileState = FileState & { generation: number };

function currentGeneration(convId: string): number {
  return generations.get(convId) ?? 0;
}

/**
 * 内容从「发给模型的历史」里离场时调用（折叠推进 / 摘要 / 撞窗硬丢）——
 * 此前的读取一律不再算「还在模型视野里」，read_file 下次要给全文。
 */
export function invalidatePriorReads(convId: string): void {
  generations.set(convId, currentGeneration(convId) + 1);
}

// Map<convId, Map<normPath, StoredFileState>>。subagent 与主对话共享同一桶（决策：认知共享）。
const store = new Map<string, Map<string, StoredFileState>>();

function bucket(convId: string): Map<string, StoredFileState> {
  let b = store.get(convId);
  if (!b) {
    b = new Map();
    store.set(convId, b);
  }
  return b;
}

function norm(path: string): string {
  return resolve(path);
}

/** read_file 读成功后回写。整读 isPartialView=false，带 offset/limit 的部分读=true。 */
export function recordRead(convId: string, path: string, st: FileState): void {
  bucket(convId).set(norm(path), { ...st, generation: currentGeneration(convId) });
}

/** 只读窥探已记录的 fileState（写前守卫的落盘复检用，无写副作用）。 */
export function peekFileState(convId: string, path: string): FileState | undefined {
  return store.get(convId)?.get(norm(path));
}

/**
 * read_file 能否只回一句「文件未变，参考上次读取的内容」而不重发全文。
 * 三个条件缺一不可：读过同一范围、磁盘 mtime 未变、这次读取之后上下文没被整理过
 * （整理过 = 上次读到的内容已不在模型视野里，必须重发）。
 */
export function canSkipReread(
  convId: string,
  path: string,
  mtime: number,
  offset: number | undefined,
  limit: number | undefined,
): boolean {
  const st = store.get(convId)?.get(norm(path));
  if (!st) return false;
  if (st.generation !== currentGeneration(convId)) return false;
  return st.mtime === mtime && st.offset === offset && st.limit === limit;
}

/**
 * 写前守卫判定（S02 · G88 按理想页 G3 口径）：
 *   - overwrite（整文件覆盖）：必须整读过（never-read / partial-only），且磁盘仍是读到的那一版
 *     （'baseline-moved' 退回重读）——覆盖丢字的「不丢」由 overwrite-guard 兜底、「不错」靠基线。
 *   - edit（局部替换）：读过即可、目标片段在已读范围内；判「目标段在当前磁盘是否仍能定位」——
 *     用户改无关段 → 目标仍在 → 放行；用户恰改目标段 → 定位不到 → 'target-moved'（工具层走 recovery）。
 * 三层检查：工具 execute 预检（早失败省 LLM 往返）→ 执行器落盘前复检（审批窗口可能分钟级）→
 * 锁内最终校验（commitWorkfileWrite baseline / apply 闭包重验）——锁外两层只为早失败，锁内才作数。
 */
export function checkGuard(
  convId: string,
  path: string,
  op: GuardOp,
  targetSnippet?: string,
  /** 调用方已整读的磁盘现状（LF 归一）——传入则免二次读盘（大文件 emit 路径的读收敛） */
  currentContent?: string,
): GuardResult {
  if (!existsSync(path)) return 'ok'; // 新建放行

  const st = bucket(convId).get(norm(path));
  if (!st) return 'never-read';

  if (op === 'overwrite') {
    if (st.isPartialView) return 'partial-only';
    // G88 基线判定：磁盘当前版必须仍是读到的那一版（LF 归一同口径），否则退回重读
    const cur = currentContent ?? readWithMeta(path).content;
    if (cur !== st.content) return 'baseline-moved';
    return 'ok';
  }

  // op === 'edit'
  if (targetSnippet !== undefined && !inReadRange(st, targetSnippet)) return 'out-of-view';
  if (targetSnippet !== undefined) {
    // 只看目标段在当前磁盘是否仍能定位（弯引号归一容忍）；定位不到 = 用户恰改了目标段
    const cur = readWithMeta(path).content;
    if (findActualString(cur, targetSnippet) === null) return 'target-moved';
  }
  return 'ok';
}

// ── recovery 重试上限（技术设计 §6/§11.9）：用户持续改目标段时的活锁防线 ──
/** 守卫连续「定位不稳」（target-moved / baseline-moved / 多处命中）的重试上限；超限暂停，不无限重试 */
export const MAX_TARGET_MOVED_RETRIES = 3;
const targetMovedCounts = new Map<string, number>(); // key = convId + '\0' + normPath

function convPathKey(convId: string, path: string): string {
  return `${convId}\0${norm(path)}`;
}

/** 记一次 target-moved，返回累计次数（达上限时 caller 让 AI 暂停 + 提示用户）。 */
export function recordTargetMoved(convId: string, path: string): number {
  const k = convPathKey(convId, path);
  const n = (targetMovedCounts.get(k) ?? 0) + 1;
  targetMovedCounts.set(k, n);
  return n;
}

/**
 * 「计数 + 超限即暂停」的统一闸——write_file / edit_file 各类定位不稳失败共用，
 * 三处调用不各自手写计数分支（文案也不漂移：paused 用 retryPausedText）。
 */
export function targetMovedGate(convId: string, path: string): { tries: number; paused: boolean } {
  const tries = recordTargetMoved(convId, path);
  // 超上限不 reset——保持暂停态直到编辑/覆盖成功落盘（resetTargetMoved），否则计数归零又能重试 3 次
  return { tries, paused: tries > MAX_TARGET_MOVED_RETRIES };
}

/** 超限暂停的统一话术（工具回执前缀由 caller 加）。 */
export function retryPausedText(path: string): string {
  return `这个文件正被频繁编辑，反复定位不到稳定的落笔点，我先暂停修改它了——${path}。等内容稳定后再让我继续。`;
}

/** 编辑成功落盘 / 文件删除 / 对话清空时清零——下次重新计数。 */
export function resetTargetMoved(convId: string, path: string): void {
  targetMovedCounts.delete(convPathKey(convId, path));
}

/**
 * 目标片段是否落在已读范围内。整读则全文都算；部分读则只有读到的那段（st.content）含目标才算。
 * 弯引号归一比较，与 edit 匹配的容忍度一致——避免文件用弯引号、old_string 用直引号时误判越界。
 */
function inReadRange(st: FileState, snippet: string): boolean {
  if (!st.isPartialView) return true;
  return normalizeQuotes(st.content).includes(normalizeQuotes(snippet));
}

/**
 * 守卫拒绝结果 → 给模型的人话指引（write_file/edit_file 共用）。
 * 无审批模式下 Oru 看到指引会自动先 read 再重试——守卫永远基于认知（决策 2）。
 */
export function guardErrorText(result: GuardResult, path: string): string {
  switch (result) {
    case 'never-read':
      return `写入前必须先 read_file 看过该文件当前内容：${path}（不能盲目覆盖未读过的文件）`;
    case 'partial-only':
      return `你只读过 ${path} 的一段，不足以整文件覆盖。请先 read_file 整读（不传 offset/limit）再用 write_file；若只想改一处，改用 edit_file 改你读过的那段。`;
    case 'target-moved':
      return `要改的那段在 ${path} 里已经找不到了（用户刚好改动了这一处）。请重新 read_file 看现状，对着新内容再试一次。`;
    case 'baseline-moved':
      return `${path} 在你读过之后被改动过（或已不存在），为避免覆盖掉别人的改动已停下。请重新 read_file 看现状，基于最新内容再写。`;
    case 'out-of-view':
      return `要编辑的片段不在你已读过的范围内：${path}。请先 read_file 读到包含该片段的那一段（或整读）再 edit_file。`;
    case 'ok':
      return '';
  }
}

/** 执行器 write/edit 落盘后回写——此时 Oru 拥有完整新内容，标整读。 */
export function afterWrite(convId: string, path: string, st: FileState): void {
  bucket(convId).set(norm(path), { ...st, generation: currentGeneration(convId) });
}

// ── D3 免审凭据：整篇产出所有权（S02，实施方案 §6）──────────────────────
// 「删除/覆盖时问」保护的是用户的字：文件从本对话 AI 整篇产出以来没被他笔碰过，
// 整篇覆盖不毁用户内容 → 视同 create 免审（deck / 长文迭代不弹卡洪水）。
// 承重边界：凭据只在 create/整篇覆盖落盘时建立——对用户内容 edit 建立不了所有权，
// 否则 AI 免审小改一笔后就能免审整篇覆盖用户文档。竞态由锁内 baseline 校验兜住（G88）：
// 免审判断在 emit 时（锁外），过期也改不错。
const ownershipHashes = new Map<string, string>(); // key = convId + '\0' + normPath → sha256(整篇内容)

function contentHash(content: string): string {
  // BOM/CRLF 归一后再哈希——凭据建立时拿的是模型原文（可能带 \r\n），比对时拿的是
  // readWithMeta 归一后的磁盘内容；口径不一致会让凭据永不命中、D3 对该文件静默失效
  const normalized = content.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  return createHash('sha256').update(normalized, 'utf-8').digest('hex');
}

/** create / 整篇覆盖落盘成功 → 建立（或刷新）所有权凭据。 */
export function grantOwnership(convId: string, path: string, writtenContent: string): void {
  ownershipHashes.set(convPathKey(convId, path), contentHash(writtenContent));
}

/**
 * edit 落盘成功 → 改动前磁盘仍与凭据相符（AI 迭代自己的产物）才把凭据续到改后版本；
 * 否则清除——凭据不因 edit 建立，也不在他笔插入后存续。
 */
export function renewOwnershipAfterEdit(
  convId: string,
  path: string,
  preEditContent: string,
  postEditContent: string,
): void {
  const k = convPathKey(convId, path);
  const held = ownershipHashes.get(k);
  if (held !== undefined && held === contentHash(preEditContent)) {
    ownershipHashes.set(k, contentHash(postEditContent));
  } else {
    ownershipHashes.delete(k);
  }
}

/** emit 时判免审：磁盘当前内容是否仍是本对话 AI 落盘的那一版。 */
export function isOwnedVersion(convId: string, path: string, diskContent: string): boolean {
  return ownershipHashes.get(convPathKey(convId, path)) === contentHash(diskContent);
}

/** delete 后清条目。 */
export function onDelete(convId: string, path: string): void {
  forget(convId, path);
}

/**
 * 盲写（append）落盘后：把本对话对这个文件的认知与所有权一并归零。
 *
 * 盲写 = 模型只供了一段、没见过写出去的整篇。两处记账都不能留：
 *   - 所有权凭据留下 → 「追加一行」附带解锁「整篇覆盖免审」（D3 的承重边界是「凭据只在
 *     create/整篇覆盖时建立」，append 语义上更接近 edit）；
 *   - 已读记录留下 → 模型随后 read_file 会命中 canSkipReread 的去重 stub，拿到一句
 *     「文件未变，无需重读」，而它从没见过这张表。
 */
export function forgetAfterBlindWrite(convId: string, path: string): void {
  forget(convId, path);
}

function forget(convId: string, path: string): void {
  bucket(convId).delete(norm(path));
  resetTargetMoved(convId, path);
  ownershipHashes.delete(convPathKey(convId, path));
}

/** 对话销毁/清空时清整桶。勿用 clearConversation——store.ts 已有同名。 */
export function clearConvFileState(convId: string): void {
  store.delete(convId);
  generations.delete(convId);
  // 清掉该对话所有文件的 target-moved 计数与所有权凭据
  for (const k of [...targetMovedCounts.keys()]) {
    if (k.startsWith(`${convId}\0`)) targetMovedCounts.delete(k);
  }
  for (const k of [...ownershipHashes.keys()]) {
    if (k.startsWith(`${convId}\0`)) ownershipHashes.delete(k);
  }
}
