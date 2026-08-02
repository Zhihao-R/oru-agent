/**
 * 持久授权清单回归（S24 · G30）。
 *
 * 目标问题：
 * - addGrant 幂等（同键保留首次 grantedAt）；revoke 后 isGranted 转 false。
 * - 版本号写盘；高版本文件拒读（内存空、不覆盖盘让版本倒退）。
 * - JSON 损坏 → 隔离 + 返回空清单，不物理覆盖原字节（对齐 S01/S06）。
 * - grantKey 各类稳定；delivery 键含 channel:recipient；category 键带前缀与 delivery 命名空间区隔。
 * - 旧授权迁移（2026-07-30 决策 8）：{command} 条目加载时清理回盘、幂等，其余条目保留。
 * - v1→v2（2026-07-31）：按站点 web 授权残留（channel:'web' delivery）加载时清掉回盘，
 *   迁移只跑一次（之后新产生的 bash 外发授权不受影响），迁移前留 .pre-v1.bak 原样副本。
 *
 * 走 process.env.ORU_DIR 重定向 tmpdir + 动态 import（避免 paths.ts load 时锁死 ORU_DIR）。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { grantKey } from '../../shared/proposals/grantKey';
import type { GrantScope } from '../../shared/types';

const ORU_DIR = join(tmpdir(), `oru-test-grants-store-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'local-user';
const grantsFile = join(ORU_DIR, 'users', OWNER, 'grants.json');

type Store = typeof import('../../electron/main/proposals/grants/store');
let store: Store;

async function cleanFile() {
  await fs.rm(grantsFile, { force: true });
  // 迁移前副本（.pre-v<N>.bak）已存在则不覆盖、损坏隔离副本（.corrupt-*）跨用例残留会让
  // 「隔离留副本」断言被上个用例的副本喂成假绿——用例间一律清掉
  await fs.rm(`${grantsFile}.pre-v1.bak`, { force: true });
  const dir = join(ORU_DIR, 'users', OWNER);
  if (existsSync(dir)) {
    for (const n of (await fs.readdir(dir)).filter((n) => n.includes('grants.json.corrupt-'))) {
      await fs.rm(join(dir, n), { force: true });
    }
  }
  store.__resetGrantsCacheForTest();
}

describe('grantKey', () => {
  it('grantkey_stable_classes', () => {
    expect(grantKey({ kind: 'destructive' })).toBe('destructive');
    expect(grantKey({ kind: 'unknown' })).toBe('unknown');
    expect(grantKey({ kind: 'overwrite' })).toBe('overwrite');
    expect(grantKey({ kind: 'category', id: 'mcp' })).toBe('category:mcp');
    expect(grantKey({ kind: 'delivery', channel: 'feishu', recipient: 'oc_1' })).toBe(
      'delivery:feishu:oc_1',
    );
  });

  it('grantkey_delivery_distinguishes_recipient_and_channel', () => {
    const a: GrantScope = { kind: 'delivery', channel: 'feishu', recipient: 'oc_1' };
    const b: GrantScope = { kind: 'delivery', channel: 'feishu', recipient: 'oc_2' };
    const c: GrantScope = { kind: 'delivery', channel: 'discord', recipient: 'oc_1' };
    expect(grantKey(a)).not.toBe(grantKey(b));
    expect(grantKey(a)).not.toBe(grantKey(c));
  });
});

describe('grantsStore', () => {
  beforeAll(async () => {
    await fs.mkdir(join(ORU_DIR, 'users', OWNER), { recursive: true });
    store = await import('../../electron/main/proposals/grants/store');
  });
  afterAll(async () => {
    await fs.rm(ORU_DIR, { recursive: true, force: true });
  });
  beforeEach(cleanFile);

  it('grant_add_query_persist', async () => {
    expect(await store.isGranted({ kind: 'destructive' })).toBe(false);
    const r = await store.addGrant({ kind: 'destructive' }, '破坏性命令');
    expect(r.persisted).toBe(true);
    expect(await store.isGranted({ kind: 'destructive' })).toBe(true);
    // 版本号写入
    const disk = JSON.parse(await fs.readFile(grantsFile, 'utf-8'));
    expect(disk.version).toBe(2);
    expect(disk.grants).toHaveLength(1);
  });

  it('grant_idempotent_keeps_first_grantedAt', async () => {
    await store.addGrant({ kind: 'category', id: 'scheduledTask' }, '创建自动化任务');
    const first = (await store.listGrants())[0].grantedAt;
    await new Promise((r) => setTimeout(r, 5));
    await store.addGrant({ kind: 'category', id: 'scheduledTask' }, '创建自动化任务（再次）');
    const list = await store.listGrants();
    expect(list).toHaveLength(1);
    expect(list[0].grantedAt).toBe(first); // 保留首次
  });

  it('grant_revoke_flips_isGranted', async () => {
    await store.addGrant({ kind: 'overwrite' }, '覆盖用户文件');
    expect(await store.isGranted({ kind: 'overwrite' })).toBe(true);
    await store.revokeGrant(grantKey({ kind: 'overwrite' }));
    expect(await store.isGranted({ kind: 'overwrite' })).toBe(false);
    expect(await store.listGrants()).toHaveLength(0);
  });

  it('grant_delivery_scoped_by_recipient', async () => {
    await store.addGrant({ kind: 'delivery', channel: 'feishu', recipient: 'oc_1' }, '向 飞书:群1 外发');
    expect(await store.isGranted({ kind: 'delivery', channel: 'feishu', recipient: 'oc_1' })).toBe(true);
    // 另一收件人不免卡
    expect(await store.isGranted({ kind: 'delivery', channel: 'feishu', recipient: 'oc_2' })).toBe(false);
  });

  it('grant_future_version_refused_and_not_overwritten', async () => {
    // 盘上写一个未来版本文件
    await fs.writeFile(
      grantsFile,
      JSON.stringify({ version: 999, grants: [{ scope: { kind: 'destructive' }, grantedAt: 1, label: 'x' }] }),
    );
    store.__resetGrantsCacheForTest();
    // 拒读：内存空清单
    expect(await store.isGranted({ kind: 'destructive' })).toBe(false);
    // 冻结写盘：addGrant 内存生效但 persisted:false，盘上未来版本文件不被覆盖
    const r = await store.addGrant({ kind: 'destructive' }, '破坏性命令');
    expect(r.persisted).toBe(false);
    const disk = JSON.parse(await fs.readFile(grantsFile, 'utf-8'));
    expect(disk.version).toBe(999); // 原样保留
  });

  it('grant_corrupt_quarantined_and_empty', async () => {
    await fs.writeFile(grantsFile, '{ this is not valid json');
    store.__resetGrantsCacheForTest();
    expect(await store.listGrants()).toHaveLength(0);
    // 原字节被隔离到 sidecar（原路径空出）
    const dir = join(ORU_DIR, 'users', OWNER);
    const sidecars = (await fs.readdir(dir)).filter((n) => n.includes('grants.json.corrupt-'));
    expect(sidecars.length).toBeGreaterThan(0);
    // 隔离后可重建：addGrant 成功落盘
    const r = await store.addGrant({ kind: 'unknown' }, '未知命令');
    expect(r.persisted).toBe(true);
    expect(existsSync(grantsFile)).toBe(true);
  });

  it('grant_migration_drops_retired_command_scope_idempotent', async () => {
    // 决策 8：{command} 能力门退役——盘上残留条目加载时清理回盘，{destructive}/delivery 保留
    await fs.writeFile(
      grantsFile,
      JSON.stringify({
        version: 1,
        grants: [
          { scope: { kind: 'command' }, grantedAt: 1, label: '命令执行能力' },
          { scope: { kind: 'destructive' }, grantedAt: 2, label: '破坏性命令' },
          { scope: { kind: 'delivery', channel: 'feishu', recipient: 'oc_1' }, grantedAt: 3, label: '向 飞书:群1 外发' },
        ],
      }),
    );
    store.__resetGrantsCacheForTest();
    const list = await store.listGrants();
    expect(list.map((g) => g.scope.kind)).toEqual(['destructive', 'delivery']);
    // 清理已回盘
    const disk = JSON.parse(await fs.readFile(grantsFile, 'utf-8'));
    expect(disk.grants).toHaveLength(2);
    // 幂等：重复加载不再改写（盘内容稳定）
    store.__resetGrantsCacheForTest();
    await store.listGrants();
    const disk2 = JSON.parse(await fs.readFile(grantsFile, 'utf-8'));
    expect(disk2).toEqual(disk);
    // 退役 scope 不再命中免卡
    expect(await store.isGranted({ kind: 'destructive' })).toBe(true);
  });

  it('grant_migration_v2_drops_legacy_web_site_grants', async () => {
    // v1→v2（2026-07-31）：清 7/30 改造前的「按站点 web 授权」残留——web_fetch 不再消费它们
    // （改走 {webAccess} 整类），bash 外发回到弹卡重问；其余授权保留，迁移只跑一次。
    await fs.writeFile(
      grantsFile,
      JSON.stringify({
        version: 1,
        grants: [
          { scope: { kind: 'delivery', channel: 'web', recipient: 'www.bing.com' }, grantedAt: 1, label: '向 https://www.bing.com/search?q=x 外发' },
          { scope: { kind: 'delivery', channel: 'web', recipient: 'zhihu.com' }, grantedAt: 2, label: '向 https://zhihu.com/p/1 外发' },
          { scope: { kind: 'delivery', channel: 'feishu', recipient: 'oc_1' }, grantedAt: 3, label: '向 飞书:群1 外发' },
          { scope: { kind: 'category', id: 'webAccess' }, grantedAt: 4, label: '访问网站' },
          { scope: { kind: 'destructive' }, grantedAt: 5, label: '破坏性命令' },
        ],
      }),
    );
    store.__resetGrantsCacheForTest();
    const list = await store.listGrants();
    // 两条按站点 web 授权被清，其余原样保留
    expect(list.map((g) => grantKey(g.scope))).toEqual([
      'delivery:feishu:oc_1',
      'category:webAccess',
      'destructive',
    ]);
    // 旧站点授权不再命中免卡
    expect(await store.isGranted({ kind: 'delivery', channel: 'web', recipient: 'www.bing.com' })).toBe(false);
    // 迁移已回盘：版本升 2、残留清空
    const disk = JSON.parse(await fs.readFile(grantsFile, 'utf-8'));
    expect(disk.version).toBe(2);
    expect(disk.grants).toHaveLength(3);
    // 迁移前原样副本（S06）：v1 字节留在 .pre-v1.bak
    expect(JSON.parse(await fs.readFile(`${grantsFile}.pre-v1.bak`, 'utf-8')).grants).toHaveLength(5);
    // 迁移只跑一次：之后新产生的 bash 外发授权（同为 channel:'web'）不受影响、不被再清
    const r = await store.addGrant({ kind: 'delivery', channel: 'web', recipient: 'github.com' }, '向 github.com 外发');
    expect(r.persisted).toBe(true);
    store.__resetGrantsCacheForTest();
    expect(await store.isGranted({ kind: 'delivery', channel: 'web', recipient: 'github.com' })).toBe(true);
    // 幂等：重复加载不再改写（盘内容稳定）
    const stable = await fs.readFile(grantsFile, 'utf-8');
    store.__resetGrantsCacheForTest();
    await store.listGrants();
    expect(await fs.readFile(grantsFile, 'utf-8')).toBe(stable);
  });

  it('grant_concurrent_first_load_and_add_keeps_grant', async () => {
    // 并发首载竞态回归：isGranted（锁外）与 addGrant（锁内）同时首载，load 走 inflight 去重后，
    // 后完成者不得拿旧内容顶掉含新授权的 state（内存与盘都不丢）。
    await fs.writeFile(
      grantsFile,
      JSON.stringify({
        version: 1,
        grants: [{ scope: { kind: 'command' }, grantedAt: 1, label: '命令执行能力' }],
      }),
    );
    store.__resetGrantsCacheForTest();
    await Promise.all([
      store.isGranted({ kind: 'destructive' }),
      store.addGrant({ kind: 'destructive' }, '破坏性命令'),
    ]);
    expect(await store.isGranted({ kind: 'destructive' })).toBe(true);
    const disk = JSON.parse(await fs.readFile(grantsFile, 'utf-8'));
    expect(disk.grants.map((g: { scope: { kind: string } }) => g.scope.kind)).toEqual(['destructive']);
  });

  it('grant_wrong_shape_field_quarantined_not_overwritten_silently', async () => {
    // 合法 JSON 但 grants 字段类型错（手改成字符串）：同 JSON 损坏处理——隔离留副本，不静默覆盖。
    // 回归：v1→v2 迁移链曾把非数组 grants 兜底成 []，绕过这里的隔离直接抹盘（本用例此前靠
    // 上个用例残留的 corrupt- 副本假绿——cleanFile 现已清副本，断言是诚实的）
    await fs.writeFile(grantsFile, JSON.stringify({ version: 1, grants: 'hand-edited' }));
    store.__resetGrantsCacheForTest();
    expect(await store.listGrants()).toHaveLength(0);
    const dir = join(ORU_DIR, 'users', OWNER);
    const sidecars = (await fs.readdir(dir)).filter((n) => n.includes('grants.json.corrupt-'));
    expect(sidecars.length).toBeGreaterThan(0); // 留了副本，不是无声抹掉
  });

  it('grant_bare_json_non_envelope_quarantined', async () => {
    // 同类洞的姊妹情形：文件是合法 JSON 但不是封套（裸字符串）——同样隔离留副本，不静默覆盖
    await fs.writeFile(grantsFile, JSON.stringify('hand-edited'));
    store.__resetGrantsCacheForTest();
    expect(await store.listGrants()).toHaveLength(0);
    const dir = join(ORU_DIR, 'users', OWNER);
    const sidecars = (await fs.readdir(dir)).filter((n) => n.includes('grants.json.corrupt-'));
    expect(sidecars.length).toBeGreaterThan(0);
  });

  it('grant_add_rejects_invalid_scope', async () => {
    // store 是所有写入口的单源：非法形状（ws 面垃圾 scope）不落盘、按未持久回执
    const r = await store.addGrant({ kind: 'catastrophic' } as never, 'x');
    expect(r.persisted).toBe(false);
    expect(await store.listGrants()).toHaveLength(0);
  });
});
