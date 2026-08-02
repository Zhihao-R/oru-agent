/**
 * 独立 Skill 注册表（Skill 模块 v1）。
 *
 * 职责：
 * - 启动期扫 ~/.oru/skills/<name>/SKILL.md 构建内存 Map<skillId, SkillRecord>
 * - 提供 list / get / add / remove / resolveSkill 接口
 * - resolveSkill 实现回声防护：availableFromTimestamp > conversation.createdAt 视为不可见
 *
 * 注意：plugin 内 skill 的注册表由 plugins/registry.ts 维护，本模块**只管独立装 + 内置**。
 * activate_plugin 工具会从 PluginRecord.skills 拿 plugin 内 skill 元数据。
 */
import type { SkillRecord } from '@shared/types';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import matter from 'gray-matter';
import { SKILLS_DIR, skillDir } from '../runtime/paths';
import { safeWriteAsync } from '../fs/safeWrite';

/** 单一真相：skillId → SkillRecord（仅独立装 + 内置） */
const skills = new Map<string, SkillRecord>();

let initialized = false;

/** 启动期扫盘 — 失败的单条 skip，不阻塞整体（坏 manifest 不能让用户进不了应用） */
export async function initSkillRegistry(): Promise<{ loaded: number; failed: number }> {
  skills.clear();
  let loaded = 0;
  let failed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(SKILLS_DIR);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      initialized = true;
      return { loaded: 0, failed: 0 };
    }
    throw e;
  }

  // 内置清单：写在 ensureBuiltin.ts 里，扫到的 skill 如在清单内则标 builtin
  // 这样 UI 能区分"用户独立装的"vs"Oru 自带的"
  const { getBuiltinSkillNames } = await import('./ensureBuiltin');
  const builtinSet = new Set(getBuiltinSkillNames());

  for (const name of entries) {
    try {
      const dir = join(SKILLS_DIR, name);
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      const source: SkillRecord['source'] = builtinSet.has(name) ? 'builtin' : 'standalone';
      const record = await loadSkillFromDir(dir, source);
      if (!record) continue;
      skills.set(record.id, record);
      loaded += 1;
    } catch (e) {
      console.warn(`[oru.skills] 加载 skill 失败 ${name}:`, e);
      failed += 1;
    }
  }
  initialized = true;
  return { loaded, failed };
}

/**
 * 读单个 skill 目录，解析 SKILL.md frontmatter，构造 SkillRecord。
 *
 * skipped 情况：
 * - 缺 SKILL.md → return null
 * - frontmatter 缺 name/description → return null（坏 manifest 跳过）
 *
 * source='standalone' 时 id = folder name
 * source='plugin' 时 id = `${parentPluginId}:${folder name}`
 * source='builtin' 时同 standalone（id = folder name）
 */
export async function loadSkillFromDir(
  dir: string,
  source: SkillRecord['source'],
  parentPluginId?: string,
): Promise<SkillRecord | null> {
  const folderName = dir.split('/').pop()!;
  const skillMdPath = join(dir, 'SKILL.md');
  let raw: string;
  try {
    raw = await fs.readFile(skillMdPath, 'utf-8');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    throw e;
  }
  const parsed = matter(raw);
  const fm = parsed.data as Record<string, unknown>;
  const name = typeof fm.name === 'string' ? fm.name : folderName;
  const description = typeof fm.description === 'string' ? fm.description : '';
  if (!description) {
    console.warn(`[oru.skills] ${dir}: SKILL.md frontmatter 缺 description，skip`);
    return null;
  }
  // availableFromTimestamp 默认 0 = 始终可见（对所有 conversation 都早于 createdAt）。
  // 仅在 performSkillCreate / performSkillPatch 显式覆盖为 Date.now()，让"分身刚自创的"
  // skill 触发回声防护。不读文件 mtime——避免把防护机制和 OS 元数据（touch / 备份 / 时区）耦合。
  const availableFromTimestamp = 0;

  // enabled：从 sidecar .oru-skill.json 读；缺失视同 true（首次装入 / 老数据 / plugin 内 skill）
  // sidecar 选 skill 目录而非全局 settings.json 的理由：跟 skill 目录生命周期绑定，
  // skill 被删 sidecar 一起没，不会留垃圾键；放 settings 反而要装/删时同步增删条目。
  // plugin 内 skill 的 enabled 由 router 拒绝独立修改——这里只是占位，跟随父 plugin 实际生效
  let enabled = true;
  if (source !== 'plugin') {
    try {
      const sidecarRaw = await fs.readFile(join(dir, '.oru-skill.json'), 'utf-8');
      const parsedSidecar = JSON.parse(sidecarRaw) as { enabled?: unknown };
      if (typeof parsedSidecar.enabled === 'boolean') enabled = parsedSidecar.enabled;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        console.warn(`[oru.skills] ${dir}: .oru-skill.json 解析失败，按 enabled=true 处理:`, e);
      }
    }
  }

  // id 用 folderName 而非 fm.name——文件夹名是用户/installer 控制、不变量；
  // frontmatter.name 用户可改，跨改名后会导致 resolveSkill 老 id 找不到对应 skill
  const id = source === 'plugin' && parentPluginId ? `${parentPluginId}:${folderName}` : folderName;
  return {
    id,
    name,
    description,
    path: dir,
    source,
    parentPluginId,
    availableFromTimestamp,
    enabled,
  };
}

/**
 * 增量对账：把内存注册表跟 ~/.oru/skills/ 磁盘现状对齐（watcher / 面板打开触发）。
 *
 * 只增新目录、只删消失目录——**已注册条目一律不重读**。这条是硬约束：自创 skill 的
 * availableFromTimestamp（回声防护）仅存在内存、不落盘（见 loadSkillFromDir 注释），
 * 全量 clear+rebuild 会把它重置成 0 击穿防护。故绝不复用 initSkillRegistry 的清表重扫。
 *
 * 半拷贝安全：cp -r 期间目录先出现、SKILL.md 后到——loadSkillFromDir 对无合法 SKILL.md 的
 * 目录返回 null，本次跳过，内容落齐后的下次对账（watcher 再次触发）才注册。天然幂等。
 *
 * 只碰 standalone/builtin（本 Map 的全部）；plugin 内 skill 由 plugins/registry 管，不在此列。
 * 只对账目录的**增 / 删**——不重读 sidecar 的 enabled 变化（外部直接改 .oru-skill.json 不在覆盖内，
 * 用户改启停走 setSkillEnabled）。
 *
 * 单飞（single-flight）：watcher 防抖 flush 与面板打开(skill.list)可能并发触发同一对账，
 * 内存 Map 无锁、两条都跑会重复 loadSkillFromDir + 重复广播。进行中的调用共享同一 Promise，
 * 消除重入。期间到来的新盘面变化由后续 watcher 事件再触发一轮对账兜住（最终一致）。
 */
let reconcileInFlight: Promise<{ added: string[]; removed: string[] }> | null = null;

export function reconcileSkillRegistry(): Promise<{ added: string[]; removed: string[] }> {
  if (reconcileInFlight) return reconcileInFlight;
  reconcileInFlight = doReconcile().finally(() => {
    reconcileInFlight = null;
  });
  return reconcileInFlight;
}

async function doReconcile(): Promise<{ added: string[]; removed: string[] }> {
  const added: string[] = [];
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = await fs.readdir(SKILLS_DIR);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') entries = [];
    else throw e;
  }

  const { getBuiltinSkillNames } = await import('./ensureBuiltin');
  const builtinSet = new Set(getBuiltinSkillNames());
  const onDisk = new Set<string>();

  for (const name of entries) {
    try {
      const dir = join(SKILLS_DIR, name);
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      // 已在表里（standalone/builtin，id === folderName）→ 保留不动，保住内存态（回声防护）
      if (skills.has(name)) {
        onDisk.add(name);
        continue;
      }
      const source: SkillRecord['source'] = builtinSet.has(name) ? 'builtin' : 'standalone';
      const record = await loadSkillFromDir(dir, source);
      if (!record) continue; // 半拷贝 / 坏 manifest：跳过，下次对账再来
      skills.set(record.id, record);
      onDisk.add(record.id);
      added.push(record.id);
    } catch (e) {
      console.warn(`[oru.skills] 对账加载 skill 失败 ${name}:`, e);
    }
  }

  // 盘上消失的 standalone/builtin 条目：从表里撤（plugin 内 skill 不在本 Map，天然不碰）
  for (const [id, rec] of skills) {
    if (rec.source === 'plugin') continue; // 防御：本 Map 不该有 plugin，保险
    if (!onDisk.has(id)) {
      skills.delete(id);
      removed.push(id);
    }
  }

  initialized = true;
  return { added, removed };
}

export function listStandaloneSkills(): SkillRecord[] {
  return Array.from(skills.values());
}

/**
 * 当前 enabled 的所有 skill 目录绝对路径（跨表）。
 *
 * "skill 当前可见 = 它的目录可读"这条规则收敛在此，避免消费方各自重复
 * enabled 检查 / 跨 standalone+plugin 表查询。read_file 的 bundle 白名单直接消费。
 *
 * 跟 resolveSkill 同款模式：动态 import plugins/registry 避免双向依赖。
 */
export async function listEnabledSkillRoots(): Promise<string[]> {
  const roots: string[] = [];
  for (const s of skills.values()) {
    if (s.enabled) roots.push(s.path);
  }
  const { listPlugins } = await import('../plugins/registry');
  for (const p of listPlugins()) {
    if (!p.enabled) continue;
    for (const s of p.skills) roots.push(s.path);
  }
  return roots;
}

export function getSkill(skillId: string): SkillRecord | undefined {
  return skills.get(skillId);
}

/** 内部：注册表新增条目（perform 写盘成功后调） */
export function upsertSkill(record: SkillRecord): void {
  skills.set(record.id, record);
}

/** 内部：注册表移除条目（卸载 / 删除时调） */
export function removeSkillFromRegistry(skillId: string): boolean {
  return skills.delete(skillId);
}

/**
 * 设置 skill.enabled（仅 standalone / builtin）。
 * 先写 sidecar `.oru-skill.json` 再改内存：写盘失败直接抛出，router 据此回 ok=false，
 * 内存保持旧值——盘是跨重启的真相源，内存装作改成功会让用户关掉的 skill 重启「诈尸」。
 *
 * plugin 内 skill 拒绝独立切换——这里返回 'pluginInternal'，由 router 转成 ok=false 给前端。
 * 理由：plugin 是一组 skill 的整体封装单元，单切违反封装语义；想关单条应 fork plugin 或独立装。
 */
export async function setSkillEnabled(
  skillId: string,
  enabled: boolean,
): Promise<'ok' | 'notFound' | 'pluginInternal'> {
  const r = skills.get(skillId);
  if (!r) return 'notFound';
  if (r.source === 'plugin') return 'pluginInternal';
  await safeWriteAsync(join(r.path, '.oru-skill.json'), JSON.stringify({ enabled }, null, 2));
  // await 期间条目可能被 patch 重载替换——重读 Map 再改，别改到已脱离注册表的旧对象
  const cur = skills.get(skillId);
  if (cur) cur.enabled = enabled;
  return 'ok';
}

/**
 * 回声防护检查：跨注册表（standalone / plugin / builtin）解析 skillId。
 *
 * 输入是 `<skill-name>` 或 `<plugin-id>:<skill-name>`。
 * 返回 null 表示：找不到 / 创建时间晚于 conversation 创建时间（回声防护）。
 *
 * conversation.createdAt 由调用方（read_skill 工具）传入——不直接查 conversations/store
 * 避免循环依赖。
 */
export async function resolveSkill(
  skillId: string,
  conversationCreatedAt: number,
): Promise<SkillRecord | null> {
  // 先查独立注册表
  const standalone = skills.get(skillId);
  if (standalone) {
    if (standalone.availableFromTimestamp > conversationCreatedAt) return null;
    // 用户关掉的 skill 也不可见——即便是已 cache 的旧 prompt 里残留过 id
    if (!standalone.enabled) return null;
    return standalone;
  }
  // 再查 plugin 内 skill（id 形如 'pluginId:skillName'）
  const colonIdx = skillId.indexOf(':');
  if (colonIdx > 0) {
    const pluginId = skillId.slice(0, colonIdx);
    const { getPlugin } = await import('../plugins/registry');
    const plugin = getPlugin(pluginId);
    if (!plugin) return null;
    // 父 plugin 被关 → 内部 skill 也不可见
    if (!plugin.enabled) return null;
    const found = plugin.skills.find((s) => s.id === skillId);
    if (!found) return null;
    if (found.availableFromTimestamp > conversationCreatedAt) return null;
    return found;
  }
  return null;
}

/** 测试用：reset 状态 */
export function __resetForTest(): void {
  skills.clear();
  initialized = false;
  reconcileInFlight = null;
}

/** 测试用：状态 sanity check */
export function __isInitialized(): boolean {
  return initialized;
}
