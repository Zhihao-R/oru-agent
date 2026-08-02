/**
 * 记忆系统路径常量 — 单一真相源
 *
 * v2 结构（迁移后）：
 *   <userDir>/memory/
 *   ├─ MEMORY.md                              # 事件索引（按 type H3 分组）
 *   ├─ agents/
 *   │  └─ <agentName>/                        # v0.1 默认 'twin'
 *   │     ├─ self.md                          # Agent-profile
 *   │     └─ episodes/
 *   │        ├─ <date>-<slug>.md
 *   │        └─ archived/<date>-<slug>.md
 *   ├─ user/
 *   │  └─ profile.md                          # 事实段 + 画像段
 *   ├─ projects/
 *   │  └─ <projectId>/
 *   │     ├─ profile.md                       # 基本信息 + 约定 + 进度
 *   │     ├─ list-entry.md                    # 项目简介一句话
 *   │     └─ episodes/
 *   │        ├─ <date>-<slug>.md
 *   │        └─ archived/<date>-<slug>.md
 *   └─ trash/
 *      └─ <YYYY-MM-DD>/...
 *
 * v1 老路径（迁移期间并存，迁移完后删除——见 archived* / v1Personal* 函数）
 */
import { join } from 'node:path';
import { userDir } from '../runtime/paths';

/** v0.1 默认 agent 标识（多 agent 路线启动后会用 agent.id） */
export const DEFAULT_AGENT_NAME = 'twin';

/** ~/.oru/users/<ownerId>/memory/ */
export function memoryRoot(ownerId: string): string {
  return join(userDir(ownerId), 'memory');
}

/** MEMORY.md 索引绝对路径 */
export function memoryIndexPath(ownerId: string): string {
  return join(memoryRoot(ownerId), 'MEMORY.md');
}

/** memory/.dream-state.json —— dream 追跑状态（lastDreamAt 决定上线是否补跑） */
export function dreamStatePath(ownerId: string): string {
  return join(memoryRoot(ownerId), '.dream-state.json');
}

/** v2: user/profile.md */
export function userProfilePath(ownerId: string): string {
  return join(memoryRoot(ownerId), 'user', 'profile.md');
}

/** v2: projects/<id>/profile.md */
export function projectProfilePath(ownerId: string, projectId: string): string {
  return join(memoryRoot(ownerId), 'projects', projectId, 'profile.md');
}

/** v2: projects/<id>/list-entry.md */
export function projectListEntryPath(ownerId: string, projectId: string): string {
  return join(memoryRoot(ownerId), 'projects', projectId, 'list-entry.md');
}

/** v2: agents/<name>/episodes/archived/ */
export function agentArchivedEpisodesDir(
  ownerId: string,
  agentName: string = DEFAULT_AGENT_NAME,
): string {
  return join(memoryRoot(ownerId), 'agents', agentName, 'episodes', 'archived');
}

/** v2: projects/<id>/episodes/archived/ */
export function projectArchivedEpisodesDir(ownerId: string, projectId: string): string {
  return join(memoryRoot(ownerId), 'projects', projectId, 'episodes', 'archived');
}

// ─── v1 路径（迁移期保留，迁移后删除） ──────────────────────────

/** v1: .access-log.json（v2 删除） */
export function accessLogPath(ownerId: string): string {
  return join(memoryRoot(ownerId), '.access-log.json');
}

/** v1: personal/ 目录 */
export function personalDir(ownerId: string): string {
  return join(memoryRoot(ownerId), 'personal');
}

/** v1: personal/facts.md */
export function personalFactsPath(ownerId: string): string {
  return join(personalDir(ownerId), 'facts.md');
}

/** v1: personal/preferences.md */
export function personalPreferencesPath(ownerId: string): string {
  return join(personalDir(ownerId), 'preferences.md');
}

/** agents/<name>/ 目录 */
export function agentMemoryDir(ownerId: string, agentName: string = DEFAULT_AGENT_NAME): string {
  return join(memoryRoot(ownerId), 'agents', agentName);
}

/** agents/<name>/self.md（Agent-profile） */
export function agentSelfPath(ownerId: string, agentName: string = DEFAULT_AGENT_NAME): string {
  return join(agentMemoryDir(ownerId, agentName), 'self.md');
}

/** v1: agents/<name>/user-profile.md（迁移期保留，迁移后删除） */
export function agentUserProfilePath(
  ownerId: string,
  agentName: string = DEFAULT_AGENT_NAME,
): string {
  return join(agentMemoryDir(ownerId, agentName), 'user-profile.md');
}

/** agents/<name>/episodes/ 目录 */
export function agentEpisodesDir(
  ownerId: string,
  agentName: string = DEFAULT_AGENT_NAME,
): string {
  return join(agentMemoryDir(ownerId, agentName), 'episodes');
}

/** projects/<id>/ 目录 */
export function projectMemoryDir(ownerId: string, projectId: string): string {
  return join(memoryRoot(ownerId), 'projects', projectId);
}

/** projects/<id>/episodes/ 目录 */
export function projectEpisodesDir(ownerId: string, projectId: string): string {
  return join(projectMemoryDir(ownerId, projectId), 'episodes');
}

/** trash/<date>/ 目录 */
export function trashDir(ownerId: string, dateStr: string): string {
  return join(memoryRoot(ownerId), 'trash', dateStr);
}

/**
 * 这条记忆相对路径是否「文档模型档案」——user/项目 profile 与 self.md。
 *
 * 这些档案的 frontmatter 是系统自管元数据（last-updated 等），对模型不可见：注入读（dream 的
 * readDocBody）和 edit/write 都只认剥离后的 body。read_memory 据此对档案同样只回 body——让
 * 「模型为规划 edit 而读到的」== 「edit 实际会搜的」，杜绝模型按 frontmatter 边界锚 oldText 却搜不到。
 * episode（路径含 /episodes/）的 frontmatter（sources/tags）是承重内容，不在此列、保持 raw。
 */
export function isProfileDocRelPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/');
  if (norm.includes('/episodes/')) return false;
  return norm.endsWith('/profile.md') || norm.endsWith('/self.md');
}

/**
 * 递归遍历记忆库树时永远跳过的非内容子目录：回收站(trash) + 点目录(.backup-pre-v2 等
 * v1→v2 迁移备份 / 隐藏目录)。供"会递归任意子树"的遍历器共用(grep walkMd、query_episodes、
 * capture)，避免"同问题三种写法"。snapshot.walkScope 是扁平名枚举器(只读 <name>/episodes/，
 * 不递归)，结构上够不到这些目录，故不用此判定。
 * 注意：archived 不在此列——它是按需可搜的内容，是否进入由各遍历器自行决定。
 */
export function isSkippedMemoryDir(name: string): boolean {
  return name === 'trash' || name.startsWith('.');
}
