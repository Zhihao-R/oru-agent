/**
 * 行为收紧覆盖回归（2026-07-31 策略表双向开关）。
 *
 * 目标问题：
 * - setAsk 写入 / 取消 / 持久化；幂等（状态无变化不改写盘）。
 * - 白名单：非 askable 行 id（含注册表外行）拒绝写入、按未持久回执。
 * - 高版本文件拒读（内存空、不覆盖盘让版本倒退）；JSON 损坏 → 隔离 + 空清单。
 *
 * 走 process.env.ORU_DIR 重定向 tmpdir + 动态 import（避免 paths.ts load 时锁死 ORU_DIR）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-behavior-policy-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'local-user';
const policyFile = join(ORU_DIR, 'users', OWNER, 'behavior-policy.json');

type Store = typeof import('../../electron/main/proposals/behaviorPolicy/store');
let store: Store;

describe('behaviorPolicyStore', () => {
  beforeAll(async () => {
    await fs.mkdir(join(ORU_DIR, 'users', OWNER), { recursive: true });
    store = await import('../../electron/main/proposals/behaviorPolicy/store');
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });
  beforeEach(async () => {
    await fs.rm(policyFile, { force: true });
    store.__resetBehaviorPolicyCacheForTest();
  });

  it('policy_set_list_persist', async () => {
    expect(await store.isAskOverridden('create')).toBe(false);
    const r = await store.setAskOverridden('create', true);
    expect(r.persisted).toBe(true);
    expect(await store.isAskOverridden('create')).toBe(true);
    expect(await store.listAskOverrides()).toEqual(['create']);
    // 版本号写入
    const disk = JSON.parse(await fs.readFile(policyFile, 'utf-8'));
    expect(disk.version).toBe(1);
    expect(disk.askRows).toEqual(['create']);
    // 取消
    await store.setAskOverridden('create', false);
    expect(await store.isAskOverridden('create')).toBe(false);
    expect(JSON.parse(await fs.readFile(policyFile, 'utf-8')).askRows).toEqual([]);
  });

  it('policy_idempotent_no_rewrite', async () => {
    await store.setAskOverridden('modify', true);
    const stable = await fs.readFile(policyFile, 'utf-8');
    // 重复同态写入：无变化直接返回、不改写盘
    const r = await store.setAskOverridden('modify', true);
    expect(r.persisted).toBe(true);
    expect(await fs.readFile(policyFile, 'utf-8')).toBe(stable);
  });

  it('policy_rejects_non_askable_row', async () => {
    // store 是所有写入口的单源：非 askable 行（read / 注册表外垃圾）不落盘、按未持久回执
    expect((await store.setAskOverridden('read', true)).persisted).toBe(false);
    expect((await store.setAskOverridden('garbage-row', true)).persisted).toBe(false);
    expect(await store.listAskOverrides()).toEqual([]);
    expect(existsSync(policyFile)).toBe(false);
  });

  it('policy_whitelist_covers_exactly_registry_askable', () => {
    // 白名单与注册表 askable 标记同源：create/modify/aiOwned 三行可收紧
    expect(store.isAskableRow('create')).toBe(true);
    expect(store.isAskableRow('modify')).toBe(true);
    expect(store.isAskableRow('aiOwned')).toBe(true);
    expect(store.isAskableRow('catastrophic')).toBe(false);
    expect(store.isAskableRow('sendExternal')).toBe(false);
  });

  it('policy_future_version_refused_and_not_overwritten', async () => {
    await fs.writeFile(policyFile, JSON.stringify({ version: 999, askRows: ['create'] }));
    store.__resetBehaviorPolicyCacheForTest();
    // 拒读：内存空清单
    expect(await store.isAskOverridden('create')).toBe(false);
    // 冻结写盘：setAsk 内存生效但 persisted:false，盘上未来版本文件不被覆盖
    const r = await store.setAskOverridden('modify', true);
    expect(r.persisted).toBe(false);
    expect(JSON.parse(await fs.readFile(policyFile, 'utf-8')).version).toBe(999);
  });

  it('policy_corrupt_quarantined_and_empty', async () => {
    await fs.writeFile(policyFile, '{ not json');
    store.__resetBehaviorPolicyCacheForTest();
    expect(await store.listAskOverrides()).toEqual([]);
    const dir = join(ORU_DIR, 'users', OWNER);
    const sidecars = (await fs.readdir(dir)).filter((n) => n.includes('behavior-policy.json.corrupt-'));
    expect(sidecars.length).toBeGreaterThan(0);
    // 隔离后可重建
    expect((await store.setAskOverridden('aiOwned', true)).persisted).toBe(true);
    expect(existsSync(policyFile)).toBe(true);
  });

  it('policy_sanitize_drops_unknown_rows_on_load', async () => {
    // 防御性：盘上混入非白名单条目（如行从注册表 askable 除名）→ 加载时滤掉并回盘一次（对齐
    // grants 决策 8 惯例，幂等——清完后再加载无差异、不再触发写）
    await fs.writeFile(policyFile, JSON.stringify({ version: 1, askRows: ['create', 'futureRow', 42] }));
    store.__resetBehaviorPolicyCacheForTest();
    expect(await store.listAskOverrides()).toEqual(['create']);
    const disk = JSON.parse(await fs.readFile(policyFile, 'utf-8'));
    expect(disk.askRows).toEqual(['create']); // 已回盘
    store.__resetBehaviorPolicyCacheForTest();
    await store.listAskOverrides();
    expect(JSON.parse(await fs.readFile(policyFile, 'utf-8'))).toEqual(disk); // 幂等：不再改写
  });
});
