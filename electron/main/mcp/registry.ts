/**
 * 外部 MCP server 注册表（v0.5）。
 *
 * 职责：
 * - 启动期从 settings.mcpServers 读 enabled servers，spawn + handshake + 探活
 * - server 进入 connected/connected_ready 时把 tool list 反射成 AgentTool 注册到 AgentBackend
 * - server 停止/失败时把对应 AgentTool 从 AgentBackend unregister
 * - 提供 settings UI 用的查询接口（getRuntimeState / listTools）
 *
 * **三个 backend 同一条路（2026-07-27 起）**：都走 registerTool 反射，模型看到的是本进程长驻
 * client 的代理工具。claude-code 曾经改走 SDK 原生 mcpServers 透传，已随「外部 MCP 进程复用」
 * 退场——透传让 SDK 每回合新 spawn 一份 server，按连接进程授权的下游（Chrome CDP）会反复弹授权。
 */
import type { McpServerConfig, McpServerStatus } from '@shared/types';
import type { LlmUsage } from '@shared/types';
import { registerTool, unregisterTool } from '../agent/backends';
import { getSettings, updateSettings, listProjects } from '../projects/store';
import { getActiveProjectId } from '../agent/activeProject';
import { McpServerClient } from './client';
import { reflectMcpTool, reflectedToolName } from './reflectTool';
import type { McpServerRuntimeState } from './types';

const ALL_USAGES: LlmUsage[] = ['twinMain', 'twinBackground', 'subagentCoder'];

const clients = new Map<string, McpServerClient>();

/**
 * client 工厂 seam——默认 `new McpServerClient`，测试用 __setClientFactoryForTest 注入
 * 可控 fake，避免真 spawn 子进程验状态机（熔断 / 退避 / 并发去重）。
 */
let makeClient: (cfg: McpServerConfig) => McpServerClient = (cfg) => new McpServerClient(cfg);

// ─── 懒重连状态机 + 熔断（技术设计 §4.2/§4.3）────────────────────────────

/** 懒重连单次握手超时——用户在 execute 上同步干等，用 5s 短超时，不复用启动期 30s。 */
const RECONNECT_HANDSHAKE_TIMEOUT_MS = 5_000;
/** 熔断阈值：连续失败这么多次进冷却。 */
const CIRCUIT_THRESHOLD = 3;
/** 熔断冷却时长。 */
const CIRCUIT_COOLDOWN_MS = 60_000;
/** 退避间隔封顶（仅作两次尝试之间的间隔，退避中直接返回、不阻塞）。 */
const BACKOFF_CAP_MS = 30_000;

/**
 * 重连记账——**按 serverId 索引、与 client 实例生命周期解耦**。
 *
 * 绝不能记在 McpServerClient 实例上：restartServerImpl 每次重连都 `new McpServerClient`，
 * 实例字段会随重建归零、熔断永远触发不了（退化成 crash loop，正是要避免的 / C-1）。
 * 停服时 delete 清档（见 stopServerImpl）。
 */
type ReconnectState = { attempts: number; lastAttemptAt: number; circuitOpenUntil: number };
const reconnectState = new Map<string, ReconnectState>();

/** 两次尝试之间的退避间隔（指数退避，封顶 30s）；退避中直接返回、不产生阻塞。 */
function backoff(n: number): number {
  return n === 0 ? 0 : Math.min(2 ** n * 1000, BACKOFF_CAP_MS);
}

export type ReconnectOutcome = 'ready' | 'circuit_open' | 'reconnect_failed';

function isLiveStatus(c: McpServerClient | undefined): boolean {
  return c?.status === 'connected' || c?.status === 'connected_ready';
}

/**
 * 懒重连入口——reflectTool.execute 命中 `failed` 时调（技术设计 §4.3）。
 *
 * 复用现有 per-serverId 串行锁（withSerial）整块入锁：熔断判定、退避判定、重连、记账
 * 都在锁内，并发两个 execute 同时命中 failed 时第二个拿锁后重读 clients.get 复用 ready，
 * 只 spawn 一次。
 */
export function ensureReconnected(serverId: string): Promise<ReconnectOutcome> {
  return withSerial(serverId, async () => {
    const now = Date.now();
    const rs = reconnectState.get(serverId) ?? { attempts: 0, lastAttemptAt: 0, circuitOpenUntil: 0 };

    if (now < rs.circuitOpenUntil) return 'circuit_open'; // 熔断冷却中
    if (now - rs.lastAttemptAt < backoff(rs.attempts)) return 'reconnect_failed'; // 退避中，本次不试、不阻塞

    // 拿锁后先重读：并发第一个已重连成功（clients 换成新 ready 实例）→ 第二个直接复用，不重复 spawn
    if (isLiveStatus(clients.get(serverId))) {
      reconnectState.delete(serverId);
      return 'ready';
    }

    // 短超时重连；restartServerImpl 内部已先 stop 再 start，孤儿安全
    await restartServerImpl(serverId, false, undefined, {
      handshakeTimeoutMs: RECONNECT_HANDSHAKE_TIMEOUT_MS,
    });

    // ★ CLAUDE.md「await 后重检」：restart 内部 new 了新 client，必须重读 clients.get
    //   拿新实例判状态——不能沿用 await 之前读到的旧引用（那已被孤立、永远 failed）
    if (isLiveStatus(clients.get(serverId))) {
      reconnectState.delete(serverId);
      return 'ready';
    }

    rs.attempts += 1;
    rs.lastAttemptAt = now;
    if (rs.attempts >= CIRCUIT_THRESHOLD) rs.circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
    reconnectState.set(serverId, rs);
    return rs.attempts >= CIRCUIT_THRESHOLD ? 'circuit_open' : 'reconnect_failed';
  });
}

/**
 * 注入给 reflectMcpTool 的依赖——registry 把自己的两个函数传下去，避免
 * reflectTool 反向 import registry 形成循环（registry → reflectTool 已是单向）。
 */
const reflectDeps = {
  ensureReconnected,
  currentClient: (serverId: string) => clients.get(serverId),
};

/**
 * per-serverId in-flight 串行化锁。
 *
 * 用户连点 toggle / 多个 mcp.update 并发到达时，避免 startServer / stopServer
 * 同 id 并发——SDK 的 client.close 和 transport.close 对同一对象重入行为未定义。
 */
const inflight = new Map<string, Promise<unknown>>();

async function withSerial<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const prev = (inflight.get(id) as Promise<void> | undefined) ?? Promise.resolve();
  let release!: () => void;
  const releaseP = new Promise<void>((r) => (release = r));
  // 当前任务挂队尾：先等 prev settle，再等本次 release
  const myTail = prev.then(() => releaseP);
  inflight.set(id, myTail);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // 如果队尾仍是本次（没有新任务挂上来），清理 key 避免内存累积
    if (inflight.get(id) === myTail) inflight.delete(id);
  }
}

/** 全局锁——mcp.create 还没拿到 id 之前用，避免并发 create 生成同 slug */
let createLock: Promise<void> = Promise.resolve();
async function withCreateLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = createLock;
  let release!: () => void;
  const next: Promise<void> = new Promise<void>((r) => (release = r));
  createLock = prev.then(() => next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * 内部占用的 serverId——不能让用户建出来。`oru` 是 claude-code 桥接自有工具的那个 in-process
 * MCP server 的固定名字：撞上它，第三方工具的名字会变成 mcp__oru__<tool>，与自有工具的桥名同形，
 * 而 normalizeToolName 只剥一层 mcp__oru__，会把它剥成裸名当自有工具处理（只读挡的兜底判定失效、
 * 查表与上屏文案走错分支）。走 ensureUniqueId 的既有撞名机制：自动退让成 oru-2。
 */
const RESERVED_SERVER_IDS: ReadonlySet<string> = new Set(['oru']);

/** id 生成：label slugify + 跟现有 id 冲突时追加 -2 / -3 / ... */
function slugify(label: string): string {
  // 保留 CJK：id 是给人看的（settings / 日志 / 设置页），中文 label 就该得到中文 id。
  // 「wire 名必须是合法 ASCII」是模型接口对**工具名**的约束，已由 reflectTool 的
  // reflectedToolName 在合成那一步解决（非法段换稳定哈希）——不必把这个局部约束升格成 id 的
  // 全局约束，否则所有中文 label 会挤成同一个 mcp-server-N，而 serverId 是工具名里唯一携带
  // 「这是哪台服务」的那段，损失的是模型挑工具的能力、不只是可读性。
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'mcp-server';
}

function ensureUniqueId(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!existing.has(candidate)) return candidate;
  }
  // 极端兜底——理论不会到这
  return `${base}-${Date.now()}`;
}

/**
 * 启动期初始化：读 settings 找出 enabled servers 一次性启动。
 *
 * 失败的不阻塞别的——单个 server 启动失败只影响自己。
 * 返回成功启动 + 注册成 AgentTool 的 server 数量。
 */
export async function initMcpRegistry(): Promise<{ started: number; failed: number }> {
  const settings = await getSettings();
  const enabled = (settings.mcpServers ?? []).filter((s) => s.enabled);

  let started = 0;
  let failed = 0;
  await Promise.all(
    enabled.map(async (cfg) => {
      try {
        // 启动期串行已通过 withSerial 保证
        await startServer(cfg);
        started += 1;
      } catch {
        failed += 1;
      }
    }),
  );
  return { started, failed };
}

/**
 * 启动单个 MCP server（内部实现，不带串行锁）。
 *
 * 流程：实例化 client → start() → 反射 tools 注册到 AgentBackend。
 * 如果失败，client 留在 map 里（状态 failed），settings UI 仍能拿到错误信息。
 *
 * **不要直接调用**——外部入口请用带锁的 startServer。
 */
async function startServerImpl(
  cfg: McpServerConfig,
  opts: { handshakeTimeoutMs?: number } = {},
): Promise<void> {
  // 先把可能残留的旧 client 关掉
  const existing = clients.get(cfg.id);
  if (existing) {
    await stopServerImpl(cfg.id);
  }

  const client = makeClient(cfg);
  clients.set(cfg.id, client);

  try {
    await client.start(opts);
  } catch {
    // client.status 已置 failed；不重新 throw，让 UI 通过 getRuntimeState 看到
    return;
  }

  // handshake OK 后（connected / connected_ready / probe_failed）都反射工具。
  // probe_failed 也注册：让 LLM 调用时拿到明确错误文案而不是"装作没事"，
  // 由 reflectMcpTool execute 内部检查 client 状态决定走真调用还是返回错误。
  if (
    client.status === 'connected' ||
    client.status === 'connected_ready' ||
    client.status === 'probe_failed'
  ) {
    for (const tool of client.tools) {
      const agentTool = reflectMcpTool(client, tool, reflectDeps);
      // 名字的长度/字符集由 reflectedToolName 在生成时保证合法（撞上约束改写而非丢工具），
      // 这里不再二次判定——判据留在造名字的地方，两处判会漂移。
      registerTool(agentTool, ALL_USAGES);
    }
  }
  if (client.status === 'probe_failed') {
    console.warn(
      `[oru.mcp] server ${cfg.id} probe_failed: ${client.lastError ?? 'unknown'} —— 工具仍注册但调用时会返回错误`,
    );
  }
}

/**
 * 停止单个 MCP server（内部实现，不带串行锁）。
 *
 * **不要直接调用**——外部入口请用带锁的 stopServer。
 */
async function stopServerImpl(serverId: string): Promise<void> {
  // 停服即清重连记账——熔断历史不该跨"显式停/重启/删除"残留（手动重连=重新开始）。
  // 重连内部 stop→start 期间，ensureReconnected 用捕获的本地 rs 保住计数，不受此清档影响。
  reconnectState.delete(serverId);

  const client = clients.get(serverId);
  if (!client) return;

  // 先 unregister（拿到 tool names 直接查 reflectedToolName）
  for (const tool of client.tools) {
    unregisterTool(reflectedToolName(serverId, tool.name));
  }

  await client.close();
  clients.delete(serverId);
}

/**
 * 重启某 server（settings 改了之后用，内部实现）。
 *
 * `takeOver=true`（默认 false）：启动前先 pkill 系统里所有其他同名 MCP server 进程——
 * 用于解决 Chrome 144+ autoConnect 的"单 MCP client"限制。
 *
 * **不要直接调用**——外部入口请用带锁的 restartServer。
 */
async function restartServerImpl(
  serverId: string,
  takeOver: boolean,
  cfgOverride?: McpServerConfig,
  startOpts?: { handshakeTimeoutMs?: number },
): Promise<void> {
  // 优先用 caller 传入的 cfg（保证 enabled 等字段是最新的，避免 mcp.update
  // 写 settings 落盘与本函数读取之间的竞态）
  let cfg = cfgOverride;
  if (!cfg) {
    const settings = await getSettings();
    cfg = (settings.mcpServers ?? []).find((s) => s.id === serverId);
  }
  if (!cfg) {
    await stopServerImpl(serverId);
    return;
  }
  await stopServerImpl(serverId);
  if (cfg.enabled) {
    if (takeOver) {
      await killOtherMcpInstances(cfg);
      // 等几百毫秒让 OS 真把端口/IPC 释放
      await new Promise((r) => setTimeout(r, 600));
    }
    await startServerImpl(cfg, startOpts);
  }
}

// ─── 对外入口（带 per-serverId 串行锁）──────────────────────────────────

export function startServer(cfg: McpServerConfig): Promise<void> {
  return withSerial(cfg.id, () => startServerImpl(cfg));
}

export function stopServer(serverId: string): Promise<void> {
  return withSerial(serverId, () => stopServerImpl(serverId));
}

export function restartServer(
  serverId: string,
  takeOver = false,
  cfgOverride?: McpServerConfig,
): Promise<void> {
  return withSerial(serverId, () => restartServerImpl(serverId, takeOver, cfgOverride));
}

// ─── CRUD（v0.6 settings UI 用）─────────────────────────────────────────

/**
 * 新建一个 MCP server。
 *
 * - 后端生成 serverId（slugify(label) + 冲突后缀），客户端不传 id
 * - 写 settings.mcpServers
 * - 若 cfg.enabled=true → 立即 startServer
 */
export async function createServer(
  partial: Omit<McpServerConfig, 'id' | 'lastStatus' | 'lastError' | 'lastConnectedAt'>,
): Promise<McpServerConfig> {
  // createLock 只圈"读 settings → slugify → 写 settings"这段——id 一旦写盘就唯一，
  // startServer 移出锁让不同 id 的 spawn 真并发（同 turn 多 install 不再串行 30s）
  const cfg = await withCreateLock(async () => {
    const settings = await getSettings();
    const existing = new Set((settings.mcpServers ?? []).map((s) => s.id));
    const id = ensureUniqueId(slugify(partial.label), new Set([...existing, ...RESERVED_SERVER_IDS]));
    const created: McpServerConfig = { id, ...partial };
    const next = [...(settings.mcpServers ?? []), created];
    await updateSettings({ mcpServers: next });
    return created;
  });
  if (cfg.enabled) {
    // startServer 自身 withSerial(id) 防同 id 并发；不同 id 不冲突
    await startServer(cfg);
  }
  return cfg;
}

/**
 * 修改现有 MCP server。
 *
 * - 整体串行（per-serverId 锁），避免并发 update 的读-写-restart 序列交错
 * - 写盘 → 再 restart（带 cfg 直接传，restart 内不二次读 settings）
 * - 若 enabled / command / args / env / probeTool 任一改变 → restart
 * - label / description 改不重启
 *
 * 注意：内部调用的 restartServer 内部又会 withSerial(serverId)——为了避免同
 * id 自重入死锁，这里直接调 restartServerImpl（不带锁的版本）。
 */
export async function updateServer(
  serverId: string,
  patch: Partial<
    Pick<
      McpServerConfig,
      'label' | 'description' | 'command' | 'args' | 'env' | 'probeTool' | 'enabled'
    >
  >,
): Promise<McpServerConfig | null> {
  return withSerial(serverId, async () => {
    const settings = await getSettings();
    const idx = (settings.mcpServers ?? []).findIndex((s) => s.id === serverId);
    if (idx < 0) return null;
    const prev = settings.mcpServers![idx];
    const next: McpServerConfig = { ...prev, ...patch };

    // 写盘先于 restart，避免 restartServer 内部读到旧 enabled
    const list = [...settings.mcpServers!];
    list[idx] = next;
    await updateSettings({ mcpServers: list });

    const needsRestart =
      (patch.enabled !== undefined && patch.enabled !== prev.enabled) ||
      (patch.command !== undefined && patch.command !== prev.command) ||
      patch.args !== undefined ||
      patch.env !== undefined ||
      (patch.probeTool !== undefined && patch.probeTool !== prev.probeTool);
    if (needsRestart) {
      // 已在 withSerial(serverId) 内部——直接调 impl 避免重入死锁
      await restartServerImpl(serverId, false, next);
    }
    return next;
  });
}

/**
 * 删除 server：先 stop（impl 直调，避免重入死锁），再从 settings 移除。
 * 全程 per-serverId 串行。
 */
export async function deleteServer(serverId: string): Promise<boolean> {
  return withSerial(serverId, async () => {
    // best-effort 关进程
    await stopServerImpl(serverId).catch(() => {});
    const settings = await getSettings();
    const list = (settings.mcpServers ?? []).filter((s) => s.id !== serverId);
    if (list.length === (settings.mcpServers?.length ?? 0)) {
      return false; // 不存在
    }
    await updateSettings({ mcpServers: list });
    return true;
  });
}

/**
 * pkill 所有其他 chrome-devtools-mcp 进程（来自 Claude Code / Cursor / 其它 MCP client）。
 * Oru 自己 spawn 的 chrome-devtools-mcp 此时已经被 stopServer 关掉了，不会误杀。
 */
async function killOtherMcpInstances(cfg: McpServerConfig): Promise<void> {
  // 只对 chrome-devtools-mcp 做这件事——别的 MCP server 没有"单 client" 限制
  const isChromeDevtools = cfg.args.some((a) => a.includes('chrome-devtools-mcp'));
  if (!isChromeDevtools) return;
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    // 用 -9 强杀；pgrep 找 "chrome-devtools-mcp@latest" 或 "chrome-devtools-mcp" binary name
    await exec('pkill', ['-9', '-f', 'chrome-devtools-mcp@latest']).catch(() => {
      // pkill 找不到进程 exit 1 是正常情况
    });
    await exec('pkill', ['-9', '-f', 'chrome-devtools-mcp$']).catch(() => {
      /* same */
    });
  } catch {
    // 失败不阻塞——下面 startServer 反正会试连，连不上自然失败
  }
}

/**
 * 测试某 server 连接：实际跑一次 start + 立刻 stop（不留运行状态）。
 *
 * Settings UI 的"测试连接"按钮触发——结果让用户看到，不实际启用。
 *
 * 注意：如果 server 已经 enabled 在跑，本函数复用现有状态；不重启避免打断正在用的 server。
 */
export async function testServerConnection(serverId: string): Promise<McpServerRuntimeState> {
  const settings = await getSettings();
  const cfg = (settings.mcpServers ?? []).find((s) => s.id === serverId);
  if (!cfg) {
    return { serverId, status: 'failed', lastError: 'server config not found' };
  }

  // 已在跑且非 idle/failed → 直接返回当前状态（含 probe_failed）。
  // 不重新 spawn——chrome-devtools-mcp 同时两个进程会抢同一个 Chrome CDP，
  // 把现状破坏掉只是为了"测一下"很不值
  const running = clients.get(serverId);
  if (running && running.status !== 'idle' && running.status !== 'failed') {
    return {
      serverId,
      status: running.status,
      toolCount: running.tools.length,
      lastError: running.lastError,
    };
  }

  // 否则起一个临时 client，测完关掉
  const temp = new McpServerClient(cfg);
  try {
    await temp.start();
  } catch {
    /* 状态已置 failed */
  }
  const result: McpServerRuntimeState = {
    serverId,
    status: temp.status,
    toolCount: temp.tools.length,
    lastError: temp.lastError,
    lastStderr: temp.lastStderr,
  };
  await temp.close({ keepStderr: true }).catch(() => {});
  return result;
}

/**
 * 别处配置里的哪些名字是我们没有的——纯比对，不读盘（故可直接测）。
 *
 * 只比 id / label 会对出厂预设误报：预设 id 是 `preset-chrome-devtools`、label 是中文，而别处
 * 那份叫 `chrome-devtools`，两头都不等——于是每个装过 Claude Code 的用户都会被告知「你在别处
 * 配过 chrome-devtools、Oru 不会加载」，而 Oru 出厂就带着它。故再比一次命令行：真正决定
 * 「跑的是不是同一台 server」的是 command + args，别处的名字出现在我们的命令行里就是同一个东西。
 */
export function foreignNamesNotOurs(foreign: string[], ours: McpServerConfig[]): string[] {
  const byName = new Set(ours.flatMap((s) => [s.id.toLowerCase(), s.label.toLowerCase()]));
  const commandLines = ours.map((s) => `${s.command} ${s.args.join(' ')}`.toLowerCase());
  return foreign
    .filter((n) => {
      const key = n.toLowerCase();
      return !byName.has(key) && !commandLines.some((line) => line.includes(key));
    })
    .sort();
}

/**
 * 列出「用户在别的工具里配了、但 Oru 没有」的 MCP server 名。
 *
 * Oru 只加载自己 settings 里的那份（engine 侧 strictMcpConfig 恒开）。但用户很可能在 Claude Code
 * 里装过同一批服务，升级到本版本后它们静默消失——本函数让设置页能说清「少的是哪几个、去哪补」。
 * 纯读、失败即当没有（这只是一条提示，读不到别人的配置不该影响任何功能）。
 */
export async function listUnmanagedMcpServerNames(): Promise<string[]> {
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const fs = await import('node:fs/promises');

  // 项目级 .mcp.json 的位置按 **active 项目根** 解析，不用 process.cwd()——Electron 主进程的 cwd
  // 不可预测（打包后常是 / 或某系统目录），拿它拼路径等于这半条分支形同虚设。
  // 与 agentTools/pathSandbox.ts 的 defaultSearchRoot 同一套口径（那边有 ToolContext，这里没有，
  // 故直接走 activeProjectId → listProjects）。无 active 项目时只读用户级配置。
  const projectRoot = await (async (): Promise<string | null> => {
    const id = getActiveProjectId();
    if (!id) return null;
    try {
      const { projects } = await listProjects();
      return projects.find((p) => p.id === id)?.path ?? null;
    } catch {
      return null;
    }
  })();

  const sources = [
    join(homedir(), '.claude.json'),
    ...(projectRoot ? [join(projectRoot, '.mcp.json')] : []),
  ];
  const found = new Set<string>();
  for (const file of sources) {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf-8')) as {
        mcpServers?: Record<string, unknown>;
      };
      for (const name of Object.keys(parsed.mcpServers ?? {})) found.add(name);
    } catch {
      // 文件不存在 / 不是合法 JSON / 没权限——都当作「没有别处的配置」
    }
  }
  if (found.size === 0) return [];

  const settings = await getSettings().catch(() => null);
  return foreignNamesNotOurs([...found], settings?.mcpServers ?? []);
}

/** Settings UI 查询当前所有 server 的运行状态 */
export function getAllRuntimeStates(): McpServerRuntimeState[] {
  return Array.from(clients.values()).map((c) => ({
    serverId: c.config.id,
    status: c.status,
    toolCount: c.tools.length,
    lastError: c.lastError,
    lastStderr: c.lastStderr,
    circuitOpenUntil: reconnectState.get(c.config.id)?.circuitOpenUntil,
  }));
}

export function getRuntimeState(serverId: string): McpServerRuntimeState | undefined {
  const c = clients.get(serverId);
  if (!c) return undefined;
  return {
    serverId,
    status: c.status,
    toolCount: c.tools.length,
    lastError: c.lastError,
    lastStderr: c.lastStderr,
    circuitOpenUntil: reconnectState.get(serverId)?.circuitOpenUntil,
  };
}

export function listTools(
  serverId: string,
): { name: string; description: string; callableName: string }[] {
  const c = clients.get(serverId);
  if (!c) return [];
  // name 是 server 端原名（给人看：设置页的工具列表）；callableName 是模型真正能调的那个
  // ——反射名撞上接口约束时会被改写，两者不再机械可推导。给模型看原名它会去调推导出来的
  // 名字，那个名字不在声明面，回执走 undeclaredToolResult 绕开中央闸，连断路器都记不到这次失败。
  return c.tools.map((t) => ({
    name: t.name,
    description: t.description,
    callableName: reflectedToolName(serverId, t.name),
  }));
}

/** 进程退出时调，关闭所有 server 子进程 */
export async function shutdownMcpRegistry(): Promise<void> {
  await Promise.all(
    Array.from(clients.keys()).map((id) => stopServer(id).catch(() => {})),
  );
}

/** 测试用：清空 registry 状态 */
export function __resetForTest(): void {
  clients.clear();
  inflight.clear();
  reconnectState.clear();
  createLock = Promise.resolve();
  makeClient = (cfg) => new McpServerClient(cfg);
}

/** 测试用：暴露 clients map 让 smoke 验证"同一 client 实例不被重启" */
export function __getClientForTest(serverId: string): McpServerClient | undefined {
  return clients.get(serverId);
}

/** 测试用：注入 client 工厂（fake client），返回还原器。 */
export function __setClientFactoryForTest(
  fn: (cfg: McpServerConfig) => McpServerClient,
): () => void {
  const prev = makeClient;
  makeClient = fn;
  return () => {
    makeClient = prev;
  };
}

/** 测试用：读重连记账（验熔断时间戳记在 registry 层，非 client 实例）。 */
export function __getReconnectStateForTest(serverId: string): ReconnectState | undefined {
  return reconnectState.get(serverId);
}
