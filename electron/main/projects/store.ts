import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { Project, SearchEngineConfig, Settings, UnsupportedEngineConfig } from '@shared/types';
import { ErrorCodes, defaultModelThinking } from '@shared/types';
import { DEFAULT_BUDGET } from '@shared/budget/types';
import { newProjectId } from '@shared/ids';
import { getCurrentOwnerId } from '../identity/getCurrentOwnerId';
import { ORU_DIR, userDir, configPath } from '../runtime/paths';
import { createWriteQueue } from '../runtime/atomicStore';
import { quarantineCorrupt } from '../runtime/storageCorruption';
import { migrateOnRead, FutureSchemaVersionError } from '../runtime/migrateOnRead';
import { encryptSettingsForDisk, decryptSettingsInPlace } from '../backup/secrets';
import { isKnownEngineType } from '../search/engineTypes';

// 串行所有 persist + tmp+rename：避免高频 updateSettings 撕裂 config.json
const { enqueue, writeAtomic } = createWriteQueue();

type ConfigShape = {
  projects: Project[];
  activeId: string | null;
  settings: Settings;
};

// ─── 格式版本（S06·G128）─────────────────────────────────────────
// v1 = 当前形状（无 version 的存量文件视作 v1）。config 是「信任与组织结构」（项目定义 +
// 白名单 + providers），字段级演进照旧走下方逐键补默认；版本号管「改语义/删字段」级的
// 结构演进与备份还原判读（G125 前提）。version 只在序列化时注入，不进 ConfigShape。
const CONFIG_FORMAT_VERSION = 1;

const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  colorScheme: 'terracotta',
  language: 'system',
  manualApiKey: null,
  providers: [],
  models: [],
  modelAssignments: {
    twinMain: null,
    twinBackground: null,
    memoryDream: null,
    subagentCoder: null,
    conversationSummary: null,
    conversationTitle: null,
    // 对话期 subagent 默认 null —— factory.realGetBackendFor 会复用 twinMain 的分配
    twinSubagent: null,
    // 随手评点短评默认 null —— 未分配时回落 twinMain 的路由（短评必须是"这个 Oru"说的）
    asideComment: null,
    // Loop 独立审查员默认 null —— 未分配时回落默认后端（factory 的 !assignedModelId 兜住），独立不等于贵
    loopReviewer: null,
    // 记忆召回挑选器默认 null —— 未分配时回落默认后端（同上）；该配轻量小模型
    memoryRecall: null,
    // 定时任务执行体默认 null —— 未分配时回落 twinMain 的路由（执行体必须是"这个 Oru"，S18）
    scheduledRun: null,
    // Loop 拆解默认 null —— 未分配时回落 twinMain 的路由（拆解必须是"这个 Oru"）
    loopCompile: null,
  },
  // 各用途思考开关默认分档（Track B）：干活/对话类开、简单/廉价判断类关（详见 defaultModelThinking）
  modelThinking: defaultModelThinking(),
  migratedFromManualApiKey: false,
  webSearch: {
    enabled: false,
    engines: [],
    longPageSummary: true,
  },
  // 对话归档：默认开、7 天（168h）无新消息自动归档。全局一份、所有分身共用。
  autoArchive: {
    enabled: true,
    thresholdHours: 168,
  },
  // 全局用量预算（S15）：默认关——预算是用户对自己钱包的决定权，系统不预设数字。默认值单一信源
  // 在 @shared/budget/types 的 DEFAULT_BUDGET；用户在设置页「用量」区开启后填近 30 天硬上限。
  budget: { ...DEFAULT_BUDGET },
  // 全局点睛（系统级唤起对话）：默认开（PRD §5：Oru 侧默认开）——首次启动即向系统申请
  // 「输入监控 + 屏幕录制」权限；用户可在 设置→偏好→界面 关闭。
  desktopPresence: {
    enabled: true,
  },
  // 对话中阻止休眠：默认关——不主动改系统休眠行为，用户自己开（技术设计 §0 UX 决策）。
  keepAwake: {
    enabled: false,
  },
  // Loop 模式轮数硬上限（S21·G120）：默认 5（PM 拍板），用户可在设置里调；load 时 clamp 到 [1,20]。
  loopMaxRounds: 5,
  // v0.5：默认带一个 disabled 的 chrome-devtools-mcp 预设，用户显式开启后才生效
  //
  // 关键决策（v0.5.3 复盘）：用 `--autoConnect --channel=stable` 连用户**日常** Chrome。
  // autoConnect 的工作机制不走 9222 HTTP server（之前误以为撞 Chrome 安全策略，错的）：
  //   1. 用户正常启动 Chrome（**不需要** --remote-debugging-port 启动参数）
  //   2. 用户在 chrome://inspect/#remote-debugging 启用 "Discover network targets"
  //   3. chrome-devtools-mcp 请求调试会话 → Chrome 弹**授权对话框** → 用户授权后通
  //   4. 走 Chrome 内部 IPC，真用上用户日常 Chrome 的登录态/cookie/扩展
  // Chrome 144+ 支持。失败时 autoConnect 会 fallback 到自启独立 Chrome——但那就丢登录态。
  mcpServers: [
    {
      id: 'preset-chrome-devtools',
      label: 'Chrome DevTools（读社媒/登录态页面）',
      command: 'npx',
      args: [
        '-y',
        'chrome-devtools-mcp@latest',
        '--autoConnect',
        '--channel=stable',
        '--no-usage-statistics',
        '--experimentalPageIdRouting',
        '--categoryEmulation=false',
        '--categoryPerformance=false',
        '--categoryNetwork=false',
        '--categoryExtensions=false',
      ],
      enabled: false,
      lastStatus: 'idle',
    },
  ],
};

/** Loop 轮数上限 clamp：非数字/越界回落 5，否则取整钳到 [1,20]。 */
const LOOP_MAX_ROUNDS_DEFAULT = 5;
export function clampLoopMaxRounds(v: number | undefined): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return LOOP_MAX_ROUNDS_DEFAULT;
  return Math.min(20, Math.max(1, Math.round(v)));
}

const cache: Map<string, ConfigShape> = new Map();

export async function ensureOruDirs(): Promise<void> {
  await fs.mkdir(ORU_DIR, { recursive: true });
  await fs.mkdir(userDir(getCurrentOwnerId()), { recursive: true });
}

type RawProject = {
  id: string;
  path: string;
  ownerId?: string;
  name?: string;
  addedAt?: number;
  lastOpenedAt?: number;
  hasClaudeMd?: boolean;
  gitHintShownUntil?: number;
  /** 旧字段（语义为「用户主动跳过守卫」）；rehydrate 时平滑接管为 gitHintShownUntil，不静默丢失 */
  gitGuardSkippedUntil?: number;
};

/** 反序列化时给老数据补 ownerId */
function rehydrateProject(p: RawProject, ownerId: string): Project {
  return {
    id: p.id,
    ownerId,
    name: p.name ?? basename(p.path),
    path: p.path,
    addedAt: p.addedAt ?? Date.now(),
    lastOpenedAt: p.lastOpenedAt ?? Date.now(),
    hasClaudeMd: p.hasClaudeMd ?? false,
    // 旧盘只有 gitGuardSkippedUntil（守卫跳过有效期）时由新字段平滑接管——当晚末刻语义一致
    gitHintShownUntil: p.gitHintShownUntil ?? p.gitGuardSkippedUntil,
  };
}

async function load(): Promise<ConfigShape> {
  const ownerId = getCurrentOwnerId();
  const cached = cache.get(ownerId);
  if (cached) return cached;
  await ensureOruDirs();
  const path = configPath(ownerId);
  if (!existsSync(path)) {
    const empty: ConfigShape = { projects: [], activeId: null, settings: { ...DEFAULT_SETTINGS } };
    cache.set(ownerId, empty);
    // 首启首写直接调 persistInLock：load 可能被 enqueue 块内的 caller（updateSettings 等）调用，
    // 再 enqueue 会等当前 caller 完成 → 死锁。首启场景无真并发，直接同步写盘安全。
    await persistInLock();
    return empty;
  }
  const raw = await fs.readFile(path, 'utf-8').catch(() => null);
  if (raw === null) {
    // 读抖动 / 权限（非内容损坏）——回落默认但不隔离健康文件、不写盘（下次读成功即恢复）
    const fallback: ConfigShape = { projects: [], activeId: null, settings: { ...DEFAULT_SETTINGS } };
    cache.set(ownerId, fallback);
    return fallback;
  }
  try {
    // 读时版本校验（S06·G128）：version 非法 → SchemaMigrationError 落下方损坏隔离；
    // 未来版本 → 如实拒绝（绝不按旧结构读写、让版本号倒退），不隔离——它不是损坏。
    const parsed = migrateOnRead<Partial<ConfigShape> & { version?: number }>(
      JSON.parse(raw),
      [],
      CONFIG_FORMAT_VERSION,
    );
    if (typeof parsed.version === 'number' && parsed.version > CONFIG_FORMAT_VERSION) {
      throw new FutureSchemaVersionError(
        `config 格式版本 ${parsed.version} 高于本程序支持的 ${CONFIG_FORMAT_VERSION}——拒绝按旧格式读写`,
      );
    }
    const rawProjects = (Array.isArray(parsed.projects) ? parsed.projects : []) as unknown as RawProject[];
    const projects = rawProjects
      .filter((p) => !!p && !!p.id && !!p.path)
      .map((p) => rehydrateProject(p, ownerId));
    const mergedSettings: Settings = { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) };
    // 老 settings 的 modelAssignments 可能没有 v0.2 加的 conversationSummary 字段——
    // 浅 merge 会保留老字典原样，缺新键。这里再做一层 key-级补齐。
    mergedSettings.modelAssignments = {
      ...DEFAULT_SETTINGS.modelAssignments,
      ...(mergedSettings.modelAssignments ?? {}),
    };
    // modelThinking（Track B）—— 老 settings 缺字段时填默认分档（逐键补齐，防缺新 key）
    mergedSettings.modelThinking = {
      ...DEFAULT_SETTINGS.modelThinking,
      ...(mergedSettings.modelThinking ?? {}),
    };
    // 老 users 若只开过 asideThinking（旧独立开关），把它转写到 modelThinking['asideComment']——
    // 双源合一后以新字段为准，避免老用户"开过思考"的意图在新开关上丢失（Track B 回收 asideThinking）。
    // 迁移后马上消费掉旧字段（置 undefined）：否则它每次 load 都重跑，会把用户后来在新 UI 里
    // 显式关掉的 aside 思考又拉回 true——让老字段只生效一次。
    if (mergedSettings.asideThinking === true) {
      mergedSettings.modelThinking.asideComment = true;
    }
    mergedSettings.asideThinking = undefined;
    // 上网搜索（v0.3）—— 老 settings 缺字段时填默认值
    mergedSettings.webSearch = {
      ...DEFAULT_SETTINGS.webSearch!,
      ...(mergedSettings.webSearch ?? {}),
    };
    // 自动归档（对话归档）—— 老 settings 缺字段时填默认值（含部分缺失的逐键补齐）
    mergedSettings.autoArchive = {
      ...DEFAULT_SETTINGS.autoArchive!,
      ...(mergedSettings.autoArchive ?? {}),
    };
    // 全局用量预算（S15）—— 老 settings 缺字段时回落默认关（逐键补齐）
    mergedSettings.budget = {
      ...DEFAULT_SETTINGS.budget!,
      ...(mergedSettings.budget ?? {}),
    };
    // 全局点睛（系统级唤起对话）—— 老 settings 缺字段时回落默认关
    mergedSettings.desktopPresence = {
      ...DEFAULT_SETTINGS.desktopPresence!,
      ...(mergedSettings.desktopPresence ?? {}),
    };
    // 对话中阻止休眠：缺省回落关（老数据无此字段视同关，无需 migration）
    mergedSettings.keepAwake = {
      ...DEFAULT_SETTINGS.keepAwake!,
      ...(mergedSettings.keepAwake ?? {}),
    };
    // Loop 轮数上限（S21·G120）—— 老 settings 缺字段回落 5；非法/越界 clamp 到 [1,20]（用户可调但不失控）
    mergedSettings.loopMaxRounds = clampLoopMaxRounds(mergedSettings.loopMaxRounds);
    // 外部 MCP servers（v0.5）—— 老 settings 缺字段时填默认值（含 chrome-devtools-mcp 预设）
    if (!Array.isArray(mergedSettings.mcpServers)) {
      mergedSettings.mcpServers = DEFAULT_SETTINGS.mcpServers ? [...DEFAULT_SETTINGS.mcpServers] : [];
    }
    // v0.5.3：preset 的 command/args/probeTool 是 Oru 代码控制的字段，永远跟 DEFAULT_SETTINGS 对齐。
    // 用户的 settings 只持久化 enabled/lastStatus/env/label 等**用户视角的状态**——
    // 没这一步的话改了 preset 参数对老用户无效（settings 里存的是 v0.5.0 老 args）。
    mergedSettings.mcpServers = mergedSettings.mcpServers.map((s) => {
      const preset = DEFAULT_SETTINGS.mcpServers?.find((d) => d.id === s.id);
      if (preset) {
        return {
          ...s,
          command: preset.command,
          args: preset.args,
          probeTool: preset.probeTool,
        };
      }
      return s;
    });
    // 移除 v0.4 残留：browserReading 字段（如有）直接 strip
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (mergedSettings as any).browserReading;
    // 密钥保管（S07·G55）：落盘密文 → 内存明文。存量明文（无前缀）原样放行、下次 persist 固化为密文。
    // 加解密只在此 load/persist 边界发生（密钥字段清单见 backup/secrets），所有消费方见到的恒为明文。
    // 垃圾引擎条目（null/缺 id/缺 type，手改或损坏）必须在 decrypt 之前丢：
    // decryptSettingsInPlace 会读每个条目的 apiKey，null 条目直接 TypeError → 整份 config
    // 被当损坏隔离重置，代价远大于丢一个本就无从展示的条目。
    dropGarbageEngineEntriesInPlace(mergedSettings);
    decryptSettingsInPlace(mergedSettings);
    // 未知引擎类型容错（可移除性地基）：磁盘 engines 里本版本不认识的 type（用户从新版本降级 /
    // 该引擎类型已被删除）从运行配置剔到 unsupportedEngines——不再一路活到 makeEngine 的 throw
    // 炸掉搜索链；persistInLock 写盘时并回 engines（条目无损，顺序并到末尾）。必须在 decrypt
    // 之后拆：这些条目的 apiKey 同样要过明文↔密文边界，拆早了会漏解密、persist 时被二次加密。
    splitUnknownEnginesInPlace(mergedSettings);
    const next: ConfigShape = {
      projects,
      activeId: parsed.activeId ?? null,
      settings: mergedSettings,
    };
    cache.set(ownerId, next);
    return next;
  } catch (e) {
    if (e instanceof FutureSchemaVersionError) throw e; // 未来版本：如实拒绝，绝不隔离/降级覆盖
    // config 损坏（信任与组织结构一坏俱坏：项目定义 + 平台白名单 + providers）：隔离原字节保全
    // （§Deg「移出读取路径、原样保留」），再回落默认——隔离后下次 persist 落新文件，损坏字节已进
    // sidecar，不再被物理覆盖。
    await quarantineCorrupt(path, 'projects/config');
    const fallback: ConfigShape = { projects: [], activeId: null, settings: { ...DEFAULT_SETTINGS } };
    cache.set(ownerId, fallback);
    return fallback;
  }
}

/** 灰化行的最低契约：展示要 type、删除要 id。连这都没有的（null/手改损坏）当垃圾丢弃。 */
function isEngineEntry(e: unknown): e is UnsupportedEngineConfig {
  return (
    !!e &&
    typeof e === 'object' &&
    typeof (e as { type?: unknown }).type === 'string' &&
    typeof (e as { id?: unknown }).id === 'string'
  );
}

function dropGarbageEngineEntriesInPlace(settings: Settings): void {
  const ws = settings.webSearch;
  if (!ws || !Array.isArray(ws.engines)) return;
  const all = ws.engines as unknown[];
  const entries = all.filter(isEngineEntry);
  if (entries.length === all.length) return;
  ws.engines = entries as unknown as SearchEngineConfig[];
  console.warn(`[webSearch] 丢弃 ${all.length - entries.length} 个垃圾引擎条目（null/缺 id/缺 type）`);
}

function splitUnknownEnginesInPlace(settings: Settings): void {
  const ws = settings.webSearch;
  if (!ws || !Array.isArray(ws.engines)) return;
  // 垃圾条目已在 decrypt 前丢弃，这里只剩「type 是否本版本认识」一件事
  const all = ws.engines as unknown as UnsupportedEngineConfig[];
  const unknown = all.filter((e) => !isKnownEngineType(e.type));
  if (unknown.length === 0) return;
  ws.engines = all.filter((e) => isKnownEngineType(e.type)) as unknown as SearchEngineConfig[];
  ws.unsupportedEngines = unknown;
  console.warn(
    `[webSearch] 过滤 ${unknown.length} 个未知引擎类型条目（磁盘保留）：${unknown.map((e) => e.type).join(', ')}`,
  );
}

/** 写盘视图：unsupportedEngines 并回 engines（条目无损、顺序并到末尾），该运行时字段本身不落盘。 */
function mergeUnknownEnginesForDisk(settings: Settings): Settings {
  const ws = settings.webSearch;
  if (!ws || ws.unsupportedEngines === undefined) return settings;
  const { unsupportedEngines, ...rest } = ws;
  return {
    ...settings,
    webSearch: {
      ...rest,
      engines: [...rest.engines, ...(unsupportedEngines as unknown as SearchEngineConfig[])],
    },
  };
}

/** 不带 enqueue 的内部 persist——caller 自己用 enqueue 包整段 RMW 防 cache 撕裂 */
async function persistInLock(): Promise<void> {
  const ownerId = getCurrentOwnerId();
  const c = cache.get(ownerId);
  if (!c) return;
  await ensureOruDirs();
  // 密钥保管（S07·G55）：内存明文 → 落盘密文。encryptSettingsForDisk 返回深拷贝，缓存 c 保持明文不变。
  // 未知引擎条目先并回 engines 再加密——它们的 apiKey 与正常条目走同一条加密边界。
  const forDisk: ConfigShape = { ...c, settings: encryptSettingsForDisk(mergeUnknownEnginesForDisk(c.settings)) };
  // 写盘统一带最新格式版本（S06·G128）——存量无 version 的老文件下次保存即固化 v1
  await writeAtomic(configPath(ownerId), JSON.stringify({ version: CONFIG_FORMAT_VERSION, ...forDisk }, null, 2));
}

export async function listProjects(): Promise<{ projects: Project[]; activeId: string | null }> {
  const c = await load();
  // 过滤掉路径已不存在的死项目（e2e/smoke 临时目录、被用户删除的目录、未挂载的外接盘等）
  // 仅在对外暴露时过滤，磁盘元数据不动 —— 路径恢复后下次启动自动回来
  return {
    projects: c.projects.filter((p) => existsSync(p.path)),
    activeId: c.activeId,
  };
}

export async function getProject(id: string): Promise<Project> {
  const c = await load();
  const p = c.projects.find((x) => x.id === id);
  if (!p) {
    const err = new Error(`project not found: ${id}`) as Error & { code?: string };
    err.code = ErrorCodes.PROJECT_NOT_FOUND;
    throw err;
  }
  return p;
}

/**
 * 指定 owner 的 config 里是否注册了某 projectId。记忆系统写 project 维度 episode 时校验
 * projectId 真实性用——必须按**传入的 ownerId** 查（不能借道 getProject / load，它们认
 * getCurrentOwnerId 的全局当前 owner，多 owner / 测试会错位）。
 *
 * 刻意不复用 load()：load 是"读不到就写一份空 config"的 ensure 语义（有写副作用），而这里要的是
 * 纯读——对一个可能不是当前 owner 的对象做存在性检查，不该顺手给它建文件。代价是与 load 的缓存
 * 之间有一个理论上的不一致窗口（addProject 原子写 rename 的瞬间可能读到旧文件），概率可忽略。
 */
export async function isRegisteredProject(ownerId: string, id: string): Promise<boolean> {
  const path = configPath(ownerId);
  if (!existsSync(path)) return false;
  try {
    const parsed = JSON.parse(await fs.readFile(path, 'utf-8')) as { projects?: { id?: string }[] };
    return Array.isArray(parsed.projects) && parsed.projects.some((p) => p?.id === id);
  } catch {
    return false;
  }
}

export async function addProject(rawPath: string): Promise<Project> {
  const ownerId = getCurrentOwnerId();
  const path = isAbsolute(rawPath) ? resolve(rawPath) : resolve(rawPath);

  // stat 校验在 enqueue 外——纯磁盘 IO 无需锁
  let stat;
  try {
    stat = await fs.stat(path);
  } catch {
    const err = new Error(`path does not exist: ${path}`) as Error & { code?: string };
    err.code = ErrorCodes.PROJECT_PATH_INVALID;
    throw err;
  }
  if (!stat.isDirectory()) {
    const err = new Error(`path is not a directory: ${path}`) as Error & { code?: string };
    err.code = ErrorCodes.PROJECT_PATH_INVALID;
    throw err;
  }

  return enqueue(async () => {
    const c = await load();
    if (c.projects.find((p) => p.path === path)) {
      const err = new Error(`project already added: ${path}`) as Error & { code?: string };
      err.code = ErrorCodes.PROJECT_DUPLICATE;
      throw err;
    }
    const hasClaudeMd = existsSync(join(path, 'CLAUDE.md'));
    const now = Date.now();
    const project: Project = {
      id: newProjectId(),
      ownerId,
      name: basename(path),
      path,
      addedAt: now,
      lastOpenedAt: now,
      hasClaudeMd,
    };
    c.projects.push(project);
    c.activeId = project.id;
    await persistInLock();
    return project;
  });
}

export async function removeProject(id: string): Promise<void> {
  return enqueue(async () => {
    const c = await load();
    const p = c.projects.find((p) => p.id === id);
    if (!p) {
      const err = new Error(`project not found: ${id}`) as Error & { code?: string };
      err.code = ErrorCodes.PROJECT_NOT_FOUND;
      throw err;
    }
    c.projects.splice(c.projects.indexOf(p), 1);
    if (c.activeId === id) {
      c.activeId = c.projects[0]?.id ?? null;
    }
    await persistInLock();

    // 从 Oru 记忆里抹掉该项目的档案（profile / list-entry 送回收站可恢复），
    // 保留 episodes（项目事件属历史记录，不随删除清除）。
    await removeProjectMemory(p.ownerId, id);
  });
}

/**
 * 删除某项目在 Oru 记忆里的档案：projects/<id>/profile.md 与 list-entry.md 送进
 * 30 天回收站，episodes/ 目录原样保留。memory 下无该目录时静默跳过。
 */
async function removeProjectMemory(ownerId: string, projectId: string): Promise<void> {
  const { projectMemoryDir } = await import('../memory/paths');
  const { moveToTrash } = await import('../memory/trash');
  for (const name of ['profile.md', 'list-entry.md']) {
    try {
      await moveToTrash(ownerId, join(projectMemoryDir(ownerId, projectId), name));
    } catch {
      // 文件不存在 / 目录不存在：无需删除，跳过
    }
  }
}

export async function switchProject(id: string): Promise<Project> {
  return enqueue(async () => {
    const c = await load();
    const p = c.projects.find((x) => x.id === id);
    if (!p) {
      const err = new Error(`project not found: ${id}`) as Error & { code?: string };
      err.code = ErrorCodes.PROJECT_NOT_FOUND;
      throw err;
    }
    p.lastOpenedAt = Date.now();
    // 重新探测 CLAUDE.md（用户可能在外部新增）
    p.hasClaudeMd = existsSync(join(p.path, 'CLAUDE.md'));
    c.activeId = id;
    await persistInLock();
    return p;
  });
}

/**
 * 标记「今天已就该项目提示过『难以一键回退』」。
 *
 * 判定（isGitHintShownNow）与写入整块入锁——两个并发写操作不会都在锁外判到「未提示」各推一条。
 * 返回值是本次是否真的从「未提示」翻转为「已提示」：只有拿到 true 的调用方才推消息，去重靠它。
 * 有效期取本地时区当日末刻（23:59:59.999），次日零点自然过期。
 */
export async function markGitHintShown(id: string): Promise<boolean> {
  return enqueue(async () => {
    const c = await load();
    const p = c.projects.find((x) => x.id === id);
    if (!p) return false;
    if (isGitHintShownNow(p)) return false; // 判定在锁内
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    p.gitHintShownUntil = d.getTime();
    await persistInLock();
    return true; // 仅本次真翻转才 true
  });
}

/** 当前时刻是否处于"今日已提示过该项目"有效期内。 */
export function isGitHintShownNow(p: Project, now: number = Date.now()): boolean {
  return typeof p.gitHintShownUntil === 'number' && p.gitHintShownUntil > now;
}

/**
 * 按文件绝对路径反查所属项目（前缀归属）。
 * 边界：filePath === p.path，或 filePath 在 p.path 的子目录下（下一个字符是 '/'）——
 * 避免 /foo 误中 /foobar。多项目前缀重叠时取首个命中（listProjects 顺序）。
 */
export async function findProjectByPath(filePath: string): Promise<Project | null> {
  const { projects } = await listProjects();
  for (const p of projects) {
    if (filePath === p.path || filePath.startsWith(p.path + '/')) return p;
  }
  return null;
}

/** git 判定单一来源：项目根存在 .git 即视为 git 仓。helper 与 validateProposeTarget 共用。 */
export function isGitRepo(projectPath: string): boolean {
  return existsSync(join(projectPath, '.git'));
}

export async function getSettings(): Promise<Settings> {
  const c = await load();
  return c.settings;
}

export async function updateSettings(
  patch: Partial<Settings> | ((cur: Settings) => Partial<Settings>),
): Promise<Settings> {
  return enqueue(async () => {
    const c = await load();
    // 函数式 patch 在锁内、拿到最新值再算——read-modify-write 整块入锁（白名单等 RMW 承重路径靠它防丢更新）。
    const p = typeof patch === 'function' ? patch(c.settings) : patch;
    // ⚠ 浅合并：调用方传嵌套对象（如 `{ developer: { debugLogging: true } }`）会**整个覆盖** developer
    // 字段——当前 developer 只有 1 个子字段，不出问题；将来 developer 加多个子字段时这里要改成
    // 字段级深合并（针对 webSearch / developer 等已知嵌套字段），或调用方负责自带完整对象。
    c.settings = { ...c.settings, ...p };
    await persistInLock();
    return c.settings;
  });
}

/** 测试用：清缓存让 reload 拿到磁盘最新 */
export function __clearCacheForTest(): void {
  cache.clear();
}
