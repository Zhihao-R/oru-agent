/**
 * 运行时存储路径 — 单一真相源
 *
 * 所有跟 ~/.oru 磁盘布局相关的路径都从这里出。
 * 业务代码不要再各自 join(homedir(), '.oru', ...) 拼路径。
 *
 * 结构（user-scoped 布局）：
 *   ~/.oru/                                          ← ORU_DIR
 *   └─ users/                                        ← USERS_DIR
 *      └─ <ownerId>/                                 ← userDir(ownerId)
 *         ├─ agents/                                 ← agentsDir
 *         │  └─ <agentId>/home/                      ← agent.homePath
 *         ├─ agents.json                             ← agentsIndex
 *         ├─ conversations/<agentId>/<convId>.jsonl  ← convDir / 内部拼
 *         ├─ conversations/<agentId>/<convId>-images/      ← conversationImagesDir
 *         ├─ conversations/<agentId>/<convId>-tool-cache/  ← conversationToolCacheDir (v0.4 源头落盘)
 *         ├─ tasks/<taskId>.{json,jsonl,...}         ← tasksDir
 *         └─ config.json                             ← configPath
 *
 * 这是审计文档提到的"运行时配置层"雏形——以后 daemon 化想换路径
 * （例如改成支持配置文件 / 命令行 flag），只改这一个模块。
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

// 硬护栏：vitest 下 ORU_DIR 必须已注入（正常由 tests/setup/oruDir.ts 兜底）。走到这里说明
// 测试绕开了全局 setup——宁可抛错拒跑，绝不静默回落真实 ~/.oru（backup 测试曾因 vi.mock
// 提升让本模块在 env 注入前求值，覆盖了真实用户数据；隔离失效必须响）。
if (process.env.VITEST && !process.env.ORU_DIR) {
  throw new Error('paths.ts：vitest 环境缺少 ORU_DIR——测试禁止落真实 ~/.oru（tests/setup/oruDir.ts 未生效？）');
}

/** 顶层 ~/.oru 路径；测试时通过 process.env.ORU_DIR 重定向到 tmpdir */
export const ORU_DIR = process.env.ORU_DIR ?? join(homedir(), '.oru');

/** ~/.oru/users/ */
export const USERS_DIR = join(ORU_DIR, 'users');

/** ~/.oru/users/<ownerId>/ */
export function userDir(ownerId: string): string {
  return join(USERS_DIR, ownerId);
}

/** ~/.oru/users/<ownerId>/agents/ */
export function agentsDir(ownerId: string): string {
  return join(userDir(ownerId), 'agents');
}

/** ~/.oru/users/<ownerId>/agents.json */
export function agentsIndex(ownerId: string): string {
  return join(userDir(ownerId), 'agents.json');
}

/** ~/.oru/users/<ownerId>/config.json（项目列表 + settings） */
export function configPath(ownerId: string): string {
  return join(userDir(ownerId), 'config.json');
}

/** ~/.oru/users/<ownerId>/conversations/ */
export function convDir(ownerId: string): string {
  return join(userDir(ownerId), 'conversations');
}

/** ~/.oru/users/<ownerId>/tasks/ */
export function tasksDir(ownerId: string): string {
  return join(userDir(ownerId), 'tasks');
}

/** ~/.oru/users/<ownerId>/scheduled-tasks/ — 定时任务持久化目录（每条一个 <id>.json） */
export function scheduledTasksDir(ownerId: string): string {
  return join(userDir(ownerId), 'scheduled-tasks');
}

/** ~/.oru/users/<ownerId>/bg-commands/ — 后台 bash 命令登记表（S19·G18：每条一个 <id>.json + <id>.output.txt） */
export function bgCommandsDir(ownerId: string): string {
  return join(userDir(ownerId), 'bg-commands');
}

/** ~/.oru/users/<ownerId>/loop-runs/ — Loop 运行态快照（S22·G61：每个跑到一半的 loop 一个 <loopId>.json，终态即删） */
export function loopRunsDir(ownerId: string): string {
  return join(userDir(ownerId), 'loop-runs');
}

/** ~/.oru/users/<ownerId>/drafts/ — 编辑器大草稿分流文件（localStorage 只留指针，超阈值草稿落这里） */
export function draftsDir(ownerId: string): string {
  return join(userDir(ownerId), 'drafts');
}

/** ~/.oru/users/<ownerId>/avatars/ — Twin / user 头像图片（同目录，文件名前缀区分） */
export function avatarsDir(ownerId: string): string {
  return join(userDir(ownerId), 'avatars');
}

/**
 * ~/.oru/users/<ownerId>/history/ — md/csv 工作文件的快照历史托管区（FileHistory）。
 * 不就地存（污染用户目录/git），按 hash(工作文件绝对路径) 寻址到子目录。
 * deck 历史另就地存 deckPath/.history/（自带指针模型，不走这里）。
 */
export function historyDir(ownerId: string): string {
  return join(userDir(ownerId), 'history');
}

/**
 * 工作文件的托管存储 slug —— sha256(工作文件绝对路径) 前 32 位。
 * FileHistory（子目录）与 table-prefs（<slug>.json）共用同一寻址口径，靠这一处保证不漂移。
 */
export function fileKeySlug(fileKey: string): string {
  return createHash('sha256').update(fileKey, 'utf-8').digest('hex').slice(0, 32);
}

/**
 * ~/.oru/users/<ownerId>/table-prefs/ — csv 表格视图偏好（列宽/行高）按文件持久化区。
 * 同 history：不就地存，按 hash(工作文件绝对路径) 前 32 位寻址到单个 <slug>.json。
 */
export function tablePrefsDir(ownerId: string): string {
  return join(userDir(ownerId), 'table-prefs');
}

/** ~/.oru/users/<ownerId>/profile.json — 用户自己的名字 + 头像 */
export function profilePath(ownerId: string): string {
  return join(userDir(ownerId), 'profile.json');
}

/**
 * ~/.oru/users/<ownerId>/open-conflicts.json — S29·G90 未决冲突卡登记（按文件的规范化绝对路径）。
 * 落盘只为崩溃重开提示可找回；重启扫描后即清（残留冲突态本身随渲染端丢失，只留「双方版本在历史里」的信号）。
 */
export function openConflictsPath(ownerId: string): string {
  return join(userDir(ownerId), 'open-conflicts.json');
}

/** ~/.oru/users/<ownerId>/grants.json — 「始终允许」持久授权清单（S24·G30；不可再生信任配置，进备份包） */
export function grantsPath(ownerId: string): string {
  return join(userDir(ownerId), 'grants.json');
}

/** ~/.oru/users/<ownerId>/behavior-policy.json — 行为收紧覆盖（2026-07-31：默认不问的行被用户拨成「每次问」的行 id 集） */
export function behaviorPolicyPath(ownerId: string): string {
  return join(userDir(ownerId), 'behavior-policy.json');
}

/** ~/.oru/users/<ownerId>/taskboard/ — 任务（BoardTask 持久化）根目录 */
export function taskboardDir(ownerId: string): string {
  return join(userDir(ownerId), 'taskboard');
}

/** ~/.oru/users/<ownerId>/taskboard/index.json — 任务索引（BoardTaskMeta[]） */
export function taskboardIndexPath(ownerId: string): string {
  return join(taskboardDir(ownerId), 'index.json');
}

/** ~/.oru/users/<ownerId>/taskboard/tasks/ — 单任务 JSON 文件目录 */
export function taskboardTasksSubdir(ownerId: string): string {
  return join(taskboardDir(ownerId), 'tasks');
}

/** ~/.oru/users/<ownerId>/taskboard/tasks/<taskId>.json — 单任务全字段（含 description） */
export function taskboardTaskPath(ownerId: string, taskId: string): string {
  return join(taskboardTasksSubdir(ownerId), `${taskId}.json`);
}

/**
 * 单任务描述图片附件目录
 * ~/.oru/users/<ownerId>/taskboard/<taskId>-images/
 * 结构与 conversationImagesDir 同构（USERS_DIR 下 <taskId>-images/）——oru-board-img:// 校验器据此钉死。
 */
export function taskboardImagesDir(ownerId: string, taskId: string): string {
  return join(taskboardDir(ownerId), `${taskId}-images`);
}

/**
 * v0.3：单条 conversation 的图片附件目录
 * ~/.oru/users/<ownerId>/conversations/<agentId>/<convId>-images/
 * 删 conversation 时一并 rm，避免孤儿
 */
export function conversationImagesDir(
  ownerId: string,
  agentId: string,
  convId: string,
): string {
  return join(convDir(ownerId), agentId, `${convId}-images`);
}

/**
 * v0.4：单条 conversation 的工具结果落盘目录
 * ~/.oru/users/<ownerId>/conversations/<agentId>/<convId>-tool-cache/
 * 工具结果 detail 超阈值时由 stream.ts 写入 <callId>.<ext>；clear/delete conversation 时一并 rm
 */
export function conversationToolCacheDir(
  ownerId: string,
  agentId: string,
  convId: string,
): string {
  return join(convDir(ownerId), agentId, `${convId}-tool-cache`);
}

/**
 * 对话期 subagent 内部对话 sidecar 目录
 * ~/.oru/users/<ownerId>/conversations/<agentId>/<convId>-subagents/
 * 每个 subagent 一个 <taskId>.jsonl 文件；clear/delete conversation 时一并 rm
 */
export function conversationSubagentsDir(
  ownerId: string,
  agentId: string,
  convId: string,
): string {
  return join(convDir(ownerId), agentId, `${convId}-subagents`);
}

/**
 * 单条 conversation 的计划清单
 * ~/.oru/users/<ownerId>/conversations/<agentId>/<convId>-todo.json
 * 只有「还没了结」的那份会留在盘上（全部终结的清单在下一轮开始时删掉）；clear/delete conversation 时一并 rm
 */
export function conversationTodoFile(
  ownerId: string,
  agentId: string,
  convId: string,
): string {
  return join(convDir(ownerId), agentId, `${convId}-todo.json`);
}

/** 单个 subagent sidecar 文件 `<taskId>.jsonl` */
export function subagentSidecarFile(
  ownerId: string,
  agentId: string,
  convId: string,
  taskId: string,
): string {
  return join(conversationSubagentsDir(ownerId, agentId, convId), `${taskId}.jsonl`);
}

/** ~/.oru/users/<ownerId>/debug/ — 调试模块 NDJSON 落盘根目录 */
export function debugDir(ownerId: string): string {
  return join(userDir(ownerId), 'debug');
}

/** ~/.oru/users/<ownerId>/debug/<YYYY-MM-DD>/ */
export function debugDayDir(ownerId: string, dateKey: string): string {
  return join(debugDir(ownerId), dateKey);
}

/** ~/.oru/users/<ownerId>/debug/<YYYY-MM-DD>/conversation-<convId>.ndjson */
export function debugConvFile(
  ownerId: string,
  dateKey: string,
  conversationId: string,
): string {
  return join(debugDayDir(ownerId, dateKey), `conversation-${conversationId}.ndjson`);
}

// ─── Skill 模块（v1）目录 ─────────────────────────────────────
//
// Plugin / Skill 是 MVP 单用户全局共享资源（同 MCP 走 settings.mcpServers 的设计），
// 不放 users/<ownerId>/ 下——避免给多分身场景埋"按 ownerId 切目录"的迁移坑。

/** ~/.oru/plugins/ — 已装 plugin 根目录（每个 plugin 一个子目录） */
export const PLUGINS_DIR = join(ORU_DIR, 'plugins');

/** ~/.oru/plugins/<pluginId>/ */
export function pluginDir(pluginId: string): string {
  return join(PLUGINS_DIR, pluginId);
}

/** ~/.oru/skills/ — 独立装 + 内置 skill 根目录（每个 skill 一个子目录） */
export const SKILLS_DIR = join(ORU_DIR, 'skills');

/** ~/.oru/skills/<skillName>/ */
export function skillDir(skillName: string): string {
  return join(SKILLS_DIR, skillName);
}

