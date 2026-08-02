/**
 * 懒重连状态机 + 熔断（技术设计 §4.2/§4.3，测试场景 §7）。
 *
 * 锁的承重不变量：
 *  - 熔断记账在 registry 层 `reconnectState` Map（按 serverId），**不随 client 实例重建归零**
 *    —— restartServerImpl 每次都 new 一个 client，记在实例上熔断永远触发不了（C-1）。
 *  - `await restartServerImpl` 后必须重读 clients.get(serverId)：restart 内部 new 了新实例，
 *    沿用 await 之前的旧引用判状态会永远看到孤立的旧 client（CLAUDE.md「await 后重检」）。
 *  - 并发两个 execute 同时命中 failed：withSerial 串行 + 拿锁后重读 → 只 spawn 一次。
 *
 * 不真 spawn 子进程：注入 fake client factory（__setClientFactoryForTest）控制每次重连结果。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { McpServerConfig, McpServerStatus, Settings } from '@shared/types';
import type { McpServerClient } from '../../electron/main/mcp/client';

// registry 依赖 projects/store——只桩 getSettings，restartServerImpl 据此取 cfg
vi.mock('../../electron/main/projects/store', () => ({
  getSettings: vi.fn<() => Promise<Settings>>(),
  updateSettings: vi.fn(async () => {}),
}) satisfies Pick<typeof import('../../electron/main/projects/store'), 'getSettings' | 'updateSettings'>);

// 避免拉起真实 engine/SDK：registerTool / unregisterTool 桩掉
vi.mock('../../electron/main/agent/backends', () => ({
  registerTool: vi.fn(),
  unregisterTool: vi.fn(),
}) satisfies Pick<typeof import('../../electron/main/agent/backends'), 'registerTool' | 'unregisterTool'>);

import { getSettings } from '../../electron/main/projects/store';
import { makeSettings } from '../helpers/settings';
import { registerTool } from '../../electron/main/agent/backends';
import {
  ensureReconnected,
  startServer,
  __resetForTest,
  __setClientFactoryForTest,
  __getReconnectStateForTest,
  __getClientForTest,
} from '../../electron/main/mcp/registry';

const cfg: McpServerConfig = {
  id: 'srv',
  label: 'Srv',
  command: 'echo',
  args: [],
  enabled: true,
};

/** reflectTool / registry 实际触碰的 client 成员子集——class 私有字段无法结构化 satisfies。 */
type FakeClientShape = Pick<
  McpServerClient,
  'config' | 'status' | 'tools' | 'lastError' | 'start' | 'close'
>;

class FakeClient {
  config: McpServerConfig;
  status: McpServerStatus = 'idle';
  tools: McpServerClient['tools'] = [];
  lastError?: string;
  startCalls: Array<{ handshakeTimeoutMs?: number }> = [];
  constructor(cfg: McpServerConfig, private outcome: 'ready' | 'fail') {
    this.config = cfg;
  }
  async start(opts: { handshakeTimeoutMs?: number } = {}): Promise<void> {
    this.startCalls.push(opts);
    if (this.outcome === 'ready') {
      this.status = 'connected_ready';
      return;
    }
    // 真 client 失败时先置 failed 再抛；startServerImpl catch 后让它留在 map 里
    this.status = 'failed';
    this.lastError = 'fake start fail';
    throw new Error('fake start fail');
  }
  async close(): Promise<void> {
    // 模拟真 client：非 failed 才回 idle，failed 保留
    if (this.status !== 'failed') this.status = 'idle';
  }
}

/** 按 outcome 脚本逐次生产 fake client（restart 每次都 new 一个）——返回生产记录。 */
function installFakeClients(script: Array<'ready' | 'fail'>) {
  let i = 0;
  const created: FakeClient[] = [];
  __setClientFactoryForTest((c) => {
    const outcome = script[Math.min(i, script.length - 1)];
    i += 1;
    const fc = new FakeClient(c, outcome) satisfies FakeClientShape;
    created.push(fc);
    return fc as unknown as McpServerClient;
  });
  return { created, spawnCount: () => i };
}

beforeEach(() => {
  __resetForTest();
  vi.mocked(getSettings).mockResolvedValue(makeSettings({ mcpServers: [cfg] }));
  vi.mocked(registerTool).mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** 造一个"曾经连上、后来运行中崩"的 server：seed 一个 ready client 再把它打成 failed。 */
async function seedCrashedServer(reconnectScript: Array<'ready' | 'fail'>) {
  const fakes = installFakeClients(['ready', ...reconnectScript]);
  await startServer(cfg);
  const seeded = __getClientForTest(cfg.id) as unknown as FakeClient;
  expect(seeded.status).toBe('connected_ready');
  // 模拟运行中崩溃（onclose 把状态置 failed）
  seeded.status = 'failed';
  return fakes;
}

describe('ensureReconnected（§7）', () => {
  it('§7.1 运行中崩溃 → execute 触发重连成功 → reconnectState 清档', async () => {
    const fakes = await seedCrashedServer(['ready']);
    const spawnAfterSeed = fakes.spawnCount();

    const outcome = await ensureReconnected(cfg.id);

    expect(outcome).toBe('ready');
    expect(fakes.spawnCount()).toBe(spawnAfterSeed + 1); // 真重连了一次
    expect(__getReconnectStateForTest(cfg.id)).toBeUndefined(); // 成功后清档
    expect((__getClientForTest(cfg.id) as unknown as FakeClient).status).toBe('connected_ready');
  });

  it('§7.2 连续崩溃 3 次 → 第 4 次命中熔断 → 不再 spawn；circuitOpenUntil 记在 reconnectState（非 client 实例）', async () => {
    const fakes = await seedCrashedServer(['fail', 'fail', 'fail', 'fail']);
    const base = fakes.spawnCount();

    // 三次尝试都失败——每次推进时间越过退避窗口
    expect(await ensureReconnected(cfg.id)).toBe('reconnect_failed'); // attempts 1
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await ensureReconnected(cfg.id)).toBe('reconnect_failed'); // attempts 2
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await ensureReconnected(cfg.id)).toBe('circuit_open'); // attempts 3 → 熔断

    const spawnedDuringTries = fakes.spawnCount() - base;
    expect(spawnedDuringTries).toBe(3);

    const rs = __getReconnectStateForTest(cfg.id);
    expect(rs).toBeDefined();
    expect(rs!.circuitOpenUntil).toBeGreaterThan(Date.now()); // 真相源是 reconnectState 的时间戳

    // 第 4 次：熔断窗口内，直接返回，不再 spawn
    const before4th = fakes.spawnCount();
    expect(await ensureReconnected(cfg.id)).toBe('circuit_open');
    expect(fakes.spawnCount()).toBe(before4th);
  });

  it('§7.3 熔断 60s 冷却后 → execute 再次尝试重连', async () => {
    const fakes = await seedCrashedServer(['fail', 'fail', 'fail', 'ready']);
    expect(await ensureReconnected(cfg.id)).toBe('reconnect_failed');
    await vi.advanceTimersByTimeAsync(3_000);
    expect(await ensureReconnected(cfg.id)).toBe('reconnect_failed');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await ensureReconnected(cfg.id)).toBe('circuit_open');

    const beforeCooldown = fakes.spawnCount();
    // 冷却未到：不 spawn
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await ensureReconnected(cfg.id)).toBe('circuit_open');
    expect(fakes.spawnCount()).toBe(beforeCooldown);

    // 越过 60s 冷却：再次尝试（这次脚本是 ready）
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await ensureReconnected(cfg.id)).toBe('ready');
    expect(fakes.spawnCount()).toBe(beforeCooldown + 1);
    expect(__getReconnectStateForTest(cfg.id)).toBeUndefined();
  });

  it('§7.4 并发两个 execute 同时命中 failed → 只 spawn 一次，第二个拿锁后重读复用 ready', async () => {
    const fakes = await seedCrashedServer(['ready']);
    const base = fakes.spawnCount();

    // 不 await 之间——两个同时挂上 withSerial 队列
    const [a, b] = await Promise.all([ensureReconnected(cfg.id), ensureReconnected(cfg.id)]);

    expect(a).toBe('ready');
    expect(b).toBe('ready');
    expect(fakes.spawnCount() - base).toBe(1); // 只重连一次，第二个复用
  });

  it('§7.5 退避中：距上次尝试不足 backoff 的调用直接返回，不 spawn、不阻塞', async () => {
    const fakes = await seedCrashedServer(['fail', 'fail']);
    expect(await ensureReconnected(cfg.id)).toBe('reconnect_failed'); // attempts 1, backoff(1)=2s
    const afterFirst = fakes.spawnCount();

    // 同一时刻立刻再调：仍在 2s 退避窗口内 → 直接返回，不 spawn
    expect(await ensureReconnected(cfg.id)).toBe('reconnect_failed');
    expect(fakes.spawnCount()).toBe(afterFirst);
  });

  it('§7.7 重连用 5s 短握手超时（透传给 client.start），非启动期 30s', async () => {
    const fakes = await seedCrashedServer(['fail']);
    await ensureReconnected(cfg.id);
    // 重连那次新建的 client（seed 之后的第一个）拿到 5s override
    const reconnectClient = fakes.created[fakes.created.length - 1];
    expect(reconnectClient.startCalls.at(-1)?.handshakeTimeoutMs).toBe(5_000);
  });
});

describe('§7.6 regression：初连失败的 server 工具从没注册 → execute 永不触发', () => {
  it('startServer 初连失败时不 registerTool（无反射工具 → execute 不可达）', async () => {
    installFakeClients(['fail']);
    await startServer(cfg);
    expect(__getClientForTest(cfg.id)).toBeDefined();
    expect((__getClientForTest(cfg.id) as unknown as FakeClient).status).toBe('failed');
    expect(vi.mocked(registerTool)).not.toHaveBeenCalled();
  });
});
