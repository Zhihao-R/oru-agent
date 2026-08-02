/**
 * Plugin 注册表（Skill 模块 v1）。
 *
 * 职责：
 * - 启动期扫 ~/.oru/plugins/<pluginId>/ 构建 Map<pluginId, PluginRecord>
 * - 提供 list / get / upsert / remove 接口
 * - PluginRecord.skills 直接持有 plugin 内 skill 元数据（resolveSkill 会跨表查到）
 * - PluginRecord.mcpServers 仅作元数据展示——真实启动复用 mcp/registry.ts（plugin 内 MCP
 *   装即启时已注册到 settings.mcpServers）
 *
 * 装/卸由 installer.ts 实现，本文件只负责注册表。
 */
import type { PluginRecord, McpServerConfig } from '@shared/types';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { PLUGINS_DIR, pluginDir } from '../runtime/paths';
import { safeWriteAsync } from '../fs/safeWrite';
import { loadSkillFromDir } from '../skills/registry';

const plugins = new Map<string, PluginRecord>();
let initialized = false;

const IGNORED_SECTION_NAMES = ['commands', 'agents', 'hooks', 'bin'] as const;

export async function initPluginRegistry(): Promise<{ loaded: number; failed: number }> {
  plugins.clear();
  let loaded = 0;
  let failed = 0;
  let entries: string[];
  try {
    entries = await fs.readdir(PLUGINS_DIR);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      initialized = true;
      return { loaded: 0, failed: 0 };
    }
    throw e;
  }

  for (const pluginId of entries) {
    try {
      const dir = join(PLUGINS_DIR, pluginId);
      const stat = await fs.stat(dir);
      if (!stat.isDirectory()) continue;
      const record = await loadPluginFromDir(pluginId, dir);
      if (!record) continue;
      plugins.set(record.id, record);
      loaded += 1;
    } catch (e) {
      console.warn(`[oru.plugins] 加载 plugin 失败 ${pluginId}:`, e);
      failed += 1;
    }
  }
  initialized = true;
  return { loaded, failed };
}

/**
 * 读单个 plugin 目录构造 PluginRecord。
 *
 * 要求：
 * - .claude-plugin/plugin.json 必须存在且含 name + description
 * - .oru-plugin.json 必须存在（installer 写入）；缺失则 PluginRecord.oruExtension 用兜底默认值
 *   （兜底用于人为手放目录到 ~/.oru/plugins/ 的情况——MVP 允许，但功能受限）
 */
export async function loadPluginFromDir(
  pluginId: string,
  dir: string,
): Promise<PluginRecord | null> {
  const manifestPath = join(dir, '.claude-plugin', 'plugin.json');
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(manifestPath, 'utf-8');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      console.warn(`[oru.plugins] ${pluginId}: 缺 .claude-plugin/plugin.json，skip`);
      return null;
    }
    throw e;
  }
  let manifest: { name?: unknown; description?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(manifestRaw);
  } catch (e) {
    console.warn(`[oru.plugins] ${pluginId}: plugin.json JSON 解析失败:`, e);
    return null;
  }
  if (typeof manifest.name !== 'string' || typeof manifest.description !== 'string') {
    console.warn(`[oru.plugins] ${pluginId}: plugin.json 缺 name 或 description`);
    return null;
  }

  // .oru-plugin.json（Oru 扩展段）
  const oruExtPath = join(dir, '.oru-plugin.json');
  let oruExt: PluginRecord['oruExtension'];
  // enabled：在 .oru-plugin.json 持久化；缺失视同 true（首次装入 / 老数据兼容）
  let enabledFromDisk = true;
  try {
    const oruRaw = await fs.readFile(oruExtPath, 'utf-8');
    const parsed = JSON.parse(oruRaw);
    oruExt = {
      activationDescription:
        typeof parsed.activationDescription === 'string'
          ? parsed.activationDescription
          : undefined,
      source: parsed.source ?? { type: 'github', url: '', commit: '' },
      installedAt: typeof parsed.installedAt === 'number' ? parsed.installedAt : Date.now(),
    };
    if (typeof parsed.enabled === 'boolean') enabledFromDisk = parsed.enabled;
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      // 人工放置的 plugin 兜底；功能受限但不阻塞
      oruExt = {
        activationDescription: undefined,
        source: { type: 'github', url: '', commit: '' },
        installedAt: Date.now(),
      };
    } else {
      console.warn(`[oru.plugins] ${pluginId}: .oru-plugin.json 解析失败:`, e);
      return null;
    }
  }

  // 扫 skills/ 子目录
  const skills = [];
  const skillsDir = join(dir, 'skills');
  try {
    const skillEntries = await fs.readdir(skillsDir);
    for (const skillName of skillEntries) {
      const sDir = join(skillsDir, skillName);
      const sStat = await fs.stat(sDir);
      if (!sStat.isDirectory()) continue;
      const sRecord = await loadSkillFromDir(sDir, 'plugin', pluginId);
      if (sRecord) skills.push(sRecord);
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      console.warn(`[oru.plugins] ${pluginId}: 扫 skills 失败:`, e);
    }
  }

  // 解析 .mcp.json（仅作元数据展示——真实启动复用 mcp/registry）
  const mcpServers: McpServerConfig[] = [];
  try {
    const mcpRaw = await fs.readFile(join(dir, '.mcp.json'), 'utf-8');
    const mcpDoc = JSON.parse(mcpRaw);
    const serversField = (mcpDoc?.mcpServers ?? {}) as Record<string, unknown>;
    for (const [name, cfgUnk] of Object.entries(serversField)) {
      const cfg = cfgUnk as { command?: unknown; args?: unknown; env?: unknown };
      if (typeof cfg.command !== 'string') continue;
      mcpServers.push({
        id: name,
        label: name,
        command: cfg.command,
        args: Array.isArray(cfg.args) ? (cfg.args as string[]) : [],
        env:
          cfg.env && typeof cfg.env === 'object'
            ? (cfg.env as Record<string, string>)
            : undefined,
        enabled: true,
      });
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      console.warn(`[oru.plugins] ${pluginId}: .mcp.json 解析失败:`, e);
    }
  }

  // 探测被忽略的段落（commands / agents / hooks / bin）— 装的时候 UI 明示
  const ignoredSections: string[] = [];
  for (const section of IGNORED_SECTION_NAMES) {
    try {
      const sStat = await fs.stat(join(dir, section));
      if (sStat.isDirectory()) ignoredSections.push(section);
    } catch {
      // 不存在跳过
    }
  }

  return {
    id: pluginId,
    manifest: {
      name: manifest.name as string,
      description: manifest.description as string,
      version: typeof manifest.version === 'string' ? manifest.version : undefined,
    },
    oruExtension: oruExt,
    skills,
    mcpServers,
    ignoredSections,
    enabled: enabledFromDisk,
  };
}

export function listPlugins(): PluginRecord[] {
  return Array.from(plugins.values());
}

export function getPlugin(pluginId: string): PluginRecord | undefined {
  return plugins.get(pluginId);
}

export function upsertPlugin(record: PluginRecord): void {
  plugins.set(record.id, record);
}

export function removePluginFromRegistry(pluginId: string): boolean {
  return plugins.delete(pluginId);
}

/**
 * 设置 plugin.enabled。UI 关掉一个 plugin → stable system prompt 不列、
 * 分身看不到激活机会。状态持久化到 .oru-plugin.json，跨重启保留。
 *
 * 先落盘再改内存：写盘失败直接抛出（router 兜住回错误给前端），内存保持旧值——
 * 盘是跨重启的真相源，内存装作改成功会让用户关掉的 plugin 重启「诈尸」。
 */
export async function setPluginEnabled(pluginId: string, enabled: boolean): Promise<boolean> {
  const r = plugins.get(pluginId);
  if (!r) return false;
  const oruExtPath = join(pluginDir(pluginId), '.oru-plugin.json');
  await safeWriteAsync(oruExtPath, JSON.stringify({ ...r.oruExtension, enabled }, null, 2));
  // await 期间条目可能被重载替换——重读 Map 再改，别改到已脱离注册表的旧对象
  const cur = plugins.get(pluginId);
  if (cur) cur.enabled = enabled;
  return true;
}

export function __resetForTest(): void {
  plugins.clear();
  initialized = false;
}

export function __isInitialized(): boolean {
  return initialized;
}
