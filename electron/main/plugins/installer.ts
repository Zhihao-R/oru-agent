/**
 * Plugin 装/卸 installer（Skill 模块 v1）。
 *
 * 关键流程：
 *
 * 1. installPluginFromGithub（探测阶段 → 由 propose 工具调用）：
 *    - mkdtemp 临时目录 → 浅 clone（--depth=1）→ 解析 plugin.json / .mcp.json
 *    - 检查 MCP server name 冲突（settings.mcpServers 已存在同名）
 *    - 探测 scripts/ / commands/ / agents/ / hooks/ / bin/ 段
 *    - 返回完整 PluginInstallProposal payload（不动文件系统）
 *
 * 2. performPluginInstall（执行阶段 → 已审批 / 免审批后调用）：
 *    - 把临时目录 mv 到 ~/.oru/plugins/<pluginId>/
 *    - 写 .oru-plugin.json（activationDescription / source / commit / installedAt）
 *    - 按 mcpConflicts 用户选择启动 plugin 内 MCP（保留旧 / 覆盖 / 并存）
 *    - 注册表 upsert
 *    - 失败时回滚（删目录、回退 MCP）后抛错
 *
 * 3. performPluginUninstall：
 *    - 副作用最终检查（blockingDependents 非空时拒绝）
 *    - 停 plugin 内 MCP（用 deleteServer，跟用户选择留用的同名 MCP 不冲突）
 *    - 删 ~/.oru/plugins/<pluginId>/ 目录
 *    - 注册表 remove
 *
 * 两个 perform 都是纯执行：状态迁移与 chip 由调用方统一收尾（proposals/outcomeChip）。
 *
 * 失败/恢复（PRD L70-73）：
 * - 网络断 / clone 失败 → 删半 clone 临时目录，registry 不动
 * - manifest 损坏 → 删 clone 目录，registry 不动
 * - plugin 内 MCP 起不来 → plugin 仍记为已装；MCP 标 failed 态可查 stderr
 */
import { promises as fs } from 'node:fs';
import { join, basename } from 'node:path';
import type {
  PluginInstallProposal,
  PluginUninstallProposal,
  McpServerConfig,
} from '@shared/types';
import type { ProposalWarning } from '@shared/proposals/outcome';
import { PLUGINS_DIR, pluginDir } from '../runtime/paths';
import { shallowCloneToTemp, shallowCloneToDir } from './sourceFetch';
import {
  loadPluginFromDir,
  upsertPlugin,
  removePluginFromRegistry,
  getPlugin,
  listPlugins,
} from './registry';
import { failure } from '../proposals/failure';

/**
 * 装载阶段的"探测结果"——给 propose 工具构造 PluginInstallProposal 用。
 * 临时 clone 已落在 tmpCloneDir，执行阶段会把它 mv 到正式位置。
 *
 * propose 工具在拿到这个结果后，**必须**把 tmpCloneDir 路径作为隐藏字段塞给 proposal
 * 的某处，让执行阶段能找到它；如果 propose 与 execute 之间 app 重启 / 临时目录被清理，
 * 执行阶段会兜底重新 clone（虽然 commit 可能漂移——边缘场景）。
 */
export type PluginProbeResult = {
  pluginId: string;
  tmpCloneDir: string;
  manifest: { name: string; description: string; version?: string };
  source: { type: 'github'; url: string; commit: string };
  containedSkills: Array<{ name: string; description: string }>;
  containedMcpServers: Array<{ name: string; command: string; args?: string[] }>;
  containsExecutableScripts: boolean;
  ignoredSections: string[];
  mcpConflicts: Array<{
    existing: McpServerConfig;
    incoming: { name: string; command: string; args?: string[] };
  }>;
};

/**
 * 给 propose 工具用：浅 clone GitHub URL → 解析 plugin → 返回探测结果（不入注册表）。
 *
 * 失败时抛错；调用方（propose 工具）catch 后给 LLM 报错。
 */
export async function probePluginFromGithub(githubUrl: string): Promise<PluginProbeResult> {
  // 浅 clone 走共用原语（depth=1 足够拿到 HEAD；后续升级 diff 时按需深 clone）
  const { dir: tmpRoot, commit } = await shallowCloneToTemp(githubUrl, 'oru-plugin-probe-');
  try {
    // 解析 plugin.json
    const manifestPath = join(tmpRoot, '.claude-plugin', 'plugin.json');
    let manifestRaw: string;
    try {
      manifestRaw = await fs.readFile(manifestPath, 'utf-8');
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new Error('plugin.json 不存在（.claude-plugin/plugin.json）');
      }
      throw e;
    }
    let manifest: { name?: unknown; description?: unknown; version?: unknown };
    try {
      manifest = JSON.parse(manifestRaw);
    } catch (e) {
      throw new Error(`plugin.json 解析失败: ${(e as Error).message}`);
    }
    if (typeof manifest.name !== 'string' || !manifest.name.trim()) {
      throw new Error('plugin.json 缺 name 字段');
    }
    if (typeof manifest.description !== 'string') {
      throw new Error('plugin.json 缺 description 字段');
    }

    const pluginId = manifest.name.trim();
    // name 会直接当目录名（pluginDir join），必须是安全单段——否则 "../../x" 可逃逸 PLUGINS_DIR
    if (
      pluginId === '.' ||
      pluginId === '..' ||
      pluginId.includes('/') ||
      pluginId.includes('\\') ||
      pluginId !== basename(pluginId)
    ) {
      throw new Error(`plugin name 非法（不能含路径分隔符或 ..）: ${pluginId}`);
    }

    // 探测 plugin 内 skill
    const containedSkills: PluginProbeResult['containedSkills'] = [];
    const skillsRoot = join(tmpRoot, 'skills');
    try {
      const entries = await fs.readdir(skillsRoot);
      const matter = (await import('gray-matter')).default;
      for (const name of entries) {
        try {
          const skillMdPath = join(skillsRoot, name, 'SKILL.md');
          const raw = await fs.readFile(skillMdPath, 'utf-8');
          const fm = matter(raw).data as Record<string, unknown>;
          containedSkills.push({
            name: typeof fm.name === 'string' ? fm.name : name,
            description: typeof fm.description === 'string' ? fm.description : '',
          });
        } catch {
          // 单条 skill 解析失败不阻止整体——执行阶段 loadPluginFromDir 会再次扫
        }
      }
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw e;
    }

    // 探测 plugin 内 MCP
    const containedMcpServers: PluginProbeResult['containedMcpServers'] = [];
    try {
      const mcpRaw = await fs.readFile(join(tmpRoot, '.mcp.json'), 'utf-8');
      const mcpDoc = JSON.parse(mcpRaw);
      const serversField = (mcpDoc?.mcpServers ?? {}) as Record<string, unknown>;
      for (const [name, cfgUnk] of Object.entries(serversField)) {
        const cfg = cfgUnk as { command?: unknown; args?: unknown };
        if (typeof cfg.command !== 'string') continue;
        containedMcpServers.push({
          name,
          command: cfg.command,
          // 过滤非字符串元素——插件 .mcp.json 不可信，与 router 的 mcp.create 校验对齐
          args: Array.isArray(cfg.args) ? cfg.args.filter((a): a is string => typeof a === 'string') : [],
        });
      }
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw e;
    }

    // 探测 scripts / 被忽略的段
    let containsExecutableScripts = false;
    try {
      const sStat = await fs.stat(join(tmpRoot, 'scripts'));
      containsExecutableScripts = sStat.isDirectory();
    } catch {
      // ignore
    }
    const ignoredSections: string[] = [];
    for (const section of ['commands', 'agents', 'hooks', 'bin']) {
      try {
        const sStat = await fs.stat(join(tmpRoot, section));
        if (sStat.isDirectory()) ignoredSections.push(section);
      } catch {
        // ignore
      }
    }

    // 检测 MCP 名冲突（与 settings.mcpServers 比对）
    const mcpConflicts: PluginProbeResult['mcpConflicts'] = [];
    if (containedMcpServers.length > 0) {
      const { getSettings } = await import('../projects/store');
      const settings = await getSettings();
      for (const incoming of containedMcpServers) {
        const existing = (settings.mcpServers ?? []).find((s) => s.id === incoming.name);
        if (existing) {
          mcpConflicts.push({ existing, incoming });
        }
      }
    }

    return {
      pluginId,
      tmpCloneDir: tmpRoot,
      manifest: {
        name: manifest.name as string,
        description: manifest.description as string,
        version: typeof manifest.version === 'string' ? manifest.version : undefined,
      },
      source: { type: 'github', url: githubUrl, commit },
      containedSkills,
      containedMcpServers,
      containsExecutableScripts,
      ignoredSections,
      mcpConflicts,
    };
  } catch (e) {
    // 探测失败：清掉临时目录
    await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

/**
 * 纯执行：装一个已审批的 plugin。成功返回装了什么（含非致命警告），失败抛错。
 *
 * proposal.source.commit 是 propose 时锁定的 commit。如果 tmpCloneDir 还在就 mv；
 * 不在（app 重启 / OS 清临时目录）就用 commit 重新浅 clone 到正式位置。
 */
export async function performPluginInstall(
  proposal: PluginInstallProposal,
): Promise<{ pluginId: string; name: string; warnings: ProposalWarning[] }> {
  const pluginId = proposal.pluginManifest.name;
  const destDir = pluginDir(pluginId);

  // 拒绝重装：destDir 已存在
  const destExists = await fs.stat(destDir).then(
    () => true,
    (e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw failure('pluginStatFailed', { error: e.message });
      return false;
    },
  );
  if (destExists) throw failure('pluginAlreadyInstalled', { id: pluginId });

  // 重新 clone 一份到正式位置（tmpCloneDir 不在 proposal payload 里——避免重启丢失依赖）
  await fs.mkdir(PLUGINS_DIR, { recursive: true });
  try {
    await shallowCloneToDir(proposal.source.url, destDir, proposal.source.commit);
  } catch (e) {
    // clone 失败 → 删半 clone 目录
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw failure('pluginCloneFailed', { error: (e as Error).message });
  }

  // 写 .oru-plugin.json
  try {
    const oruExt = {
      activationDescription: proposal.pluginManifest.description,
      source: proposal.source,
      installedAt: Date.now(),
      enabled: true,
    };
    await fs.writeFile(
      join(destDir, '.oru-plugin.json'),
      JSON.stringify(oruExt, null, 2),
      'utf-8',
    );
  } catch (e) {
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw failure('pluginManifestWriteFailed', { error: (e as Error).message });
  }

  // 启动 plugin 内 MCP。
  // v1 简化：mcpConflicts 默认走"保留旧"（PRD 三选项 UI 第 4 期之后再接）——
  // 跳过的 MCP 名字必须出现在成功 chip 文案里，不能静默漏装让用户没感知。
  const mcpStartFailures: string[] = [];
  const mcpSkippedDueToConflict: string[] = [];
  if (proposal.containedMcpServers.length > 0) {
    const conflictNames = new Set((proposal.mcpConflicts ?? []).map((c) => c.incoming.name));
    const { createServer } = await import('../mcp/registry');
    for (const incoming of proposal.containedMcpServers) {
      if (conflictNames.has(incoming.name)) {
        mcpSkippedDueToConflict.push(incoming.name);
        continue;
      }
      try {
        const cfg = await createServer({
          label: incoming.name,
          command: incoming.command,
          args: incoming.args ?? [],
          enabled: true,
        });
        // 启动失败不回滚 plugin 整体——按 PRD"plugin 仍标已装，MCP 标 failed"
        const { getRuntimeState } = await import('../mcp/registry');
        const rt = getRuntimeState(cfg.id);
        if (rt?.status === 'failed') {
          mcpStartFailures.push(`${incoming.name}: ${rt.lastError ?? '启动失败'}`);
        }
      } catch (e) {
        mcpStartFailures.push(`${incoming.name}: ${(e as Error).message}`);
      }
    }
  }

  // 加入注册表
  try {
    const record = await loadPluginFromDir(pluginId, destDir);
    if (!record) {
      // loadPluginFromDir 因 manifest 不完整返回 null——理论不该发生（probe 时已验证）
      throw new Error('注册表加载失败：plugin 目录或 manifest 异常');
    }
    upsertPlugin(record);
  } catch (e) {
    await fs.rm(destDir, { recursive: true, force: true }).catch(() => {});
    throw failure('pluginRegisterFailed', { error: (e as Error).message });
  }

  // 成功：warnings 承载「装了但有非致命问题」，与失败严格分开——混进 failureMessage 会让
  // 「executed + failureMessage 非空」自相矛盾，下游按该字段判错的代码会误报。
  // 结构化传出（不在此处取词）：这些片段最终上屏，译词收在 outcomeChip 一处按 owner 语言做。
  const warnings: ProposalWarning[] = [];
  if (mcpSkippedDueToConflict.length > 0) {
    warnings.push({ code: 'mcp-conflict-skipped', names: mcpSkippedDueToConflict });
  }
  if (mcpStartFailures.length > 0) {
    warnings.push({ code: 'mcp-start-failed', names: mcpStartFailures });
  }
  return { pluginId, name: proposal.pluginManifest.name, warnings };
}

/**
 * 纯执行：卸载一个已审批的 plugin。成功返回卸了谁，失败抛错。
 * 不碰 proposal.status、不发 chip（收尾统一在调用方，见 proposals/outcomeChip）。
 */
export async function performPluginUninstall(
  proposal: PluginUninstallProposal,
): Promise<{ pluginId: string; name: string }> {
  const record = getPlugin(proposal.pluginId);
  if (!record) throw failure('pluginNotFound', { id: proposal.pluginId });

  // 副作用最终检查（propose 时已检查一次，等待审批期间可能有变化）
  if (proposal.sideEffects.blockingDependents.length > 0) {
    throw failure('pluginHasDependents', { dependents: proposal.sideEffects.blockingDependents.join(', ') });
  }

  // 停 plugin 内 MCP（用 deleteServer）—— 跟用户保留的同名 MCP 不冲突（id 不同）
  // 注意：第 2 期简化策略——plugin 内 MCP 的 settings id == plugin 内 MCP 名（createServer 时 label 作为 slug 基础），
  // 跟用户独立装的同名 MCP 是不同 id 实例。删时按 plugin record 内的实际 id 删。
  const { deleteServer } = await import('../mcp/registry');
  for (const mcp of record.mcpServers) {
    try {
      // record.mcpServers 是从 .mcp.json 解析的元数据，id 是 .mcp.json 里的 name；
      // 真正在 settings 里的 id 可能因 ensureUniqueId 而带后缀——按 label 反查
      const { getSettings } = await import('../projects/store');
      const settings = await getSettings();
      const settingsCfg = (settings.mcpServers ?? []).find((s) => s.label === mcp.label);
      if (settingsCfg) {
        await deleteServer(settingsCfg.id);
      }
    } catch (e) {
      console.warn(`[oru.plugins] 卸载时停 MCP ${mcp.label} 失败:`, e);
      // 不阻断卸载——目录删完即可
    }
  }

  // 删目录
  try {
    await fs.rm(pluginDir(proposal.pluginId), { recursive: true, force: true });
  } catch (e) {
    throw failure('pluginRemoveDirFailed', { error: (e as Error).message });
  }

  // 注册表 remove
  removePluginFromRegistry(proposal.pluginId);

  return { pluginId: proposal.pluginId, name: record.manifest.name };
}

/**
 * 副作用检查（uninstall propose 阶段用）。
 *
 * 规则：
 * - blockingDependents：plugin 内 MCP 被**其他 plugin / 独立装的 skill** 引用 → 阻止卸载
 * - dependentSkills：plugin 内 MCP 被某个 skill 引用 → 提示但允许卸载
 * - activatedInConversation：当前 conversation 是否激活过 → 提示
 *
 * v1 简化：MCP 与 skill 之间没有显式依赖声明字段，本检查仅用 plugin 内 MCP 名做粗略匹配——
 * 如果其他 plugin 的 .mcp.json 引用同名 server 视为依赖。Skill 与 MCP 的依赖只靠"运行时调用"
 * 才能确定，v1 不做静态检查。
 */
export function computeUninstallSideEffects(
  pluginId: string,
  activatedInConversation: boolean,
): PluginUninstallProposal['sideEffects'] {
  const target = getPlugin(pluginId);
  if (!target) {
    return {
      activatedInConversation,
      dependentSkills: [],
      blockingDependents: [],
    };
  }
  const blocking: string[] = [];
  const ownMcpLabels = new Set(target.mcpServers.map((m) => m.label));
  for (const other of listPlugins()) {
    if (other.id === pluginId) continue;
    for (const otherMcp of other.mcpServers) {
      if (ownMcpLabels.has(otherMcp.label)) {
        blocking.push(other.id);
        break;
      }
    }
  }
  return {
    activatedInConversation,
    dependentSkills: [], // v1：无显式依赖声明
    blockingDependents: blocking,
  };
}

// chip 写入逻辑已收敛到 skills/chipWriter.ts —— 见 writeSkillModuleChip / broadcastPluginsState
