/**
 * 「始终允许」持久授权清单（S24 · G30 上半）。
 * - 落盘：~/.oru/users/<ownerId>/grants.json，单文件封套 `{ version, grants: Grant[] }`。
 *
 * 授权是「后果类 × 授权状态」这条与挡位正交的轴（approval.html:141）：单例整类（destructive/
 * unknown/overwrite）是常量键，category 参数化整类（决策 7 六类），delivery 按收件人＋渠道开放
 * 扩展。判别式记录 + 稳定键（grantKey 单源）让「已授权清单」逐条可列、可撤销，也让「加第 N 类
 * 后果」只加一个 scope 分支。
 *
 * 旧授权迁移（2026-07-30 决策 8）：{command} 能力门退役后，盘上残留条目在加载时被 sanitize 判
 * 非法清掉并回盘一次（幂等）；{destructive}/{overwrite}/delivery 不受影响，{unknown} 从零开始。
 * v1→v2（2026-07-31）：清 7/30 审批行为分类改造前的「按站点 web 授权」残留（见 chain 注释）。
 *
 * 损坏隔离（对齐 S01/S06）：读到 JSON 损坏 → 隔离原字节（rename 到 sidecar，原路径空出可重建）+
 * 留痕，内存空清单不静默；读到未来版本 → 内存空清单且**冻结写盘**（绝不覆盖让版本倒退）。
 * 写盘失败不抛（addGrant 返回 persisted:false，由 handler 据此如实回执，不假装持久成功）。
 * RMW 整块入锁：addGrant/revokeGrant 经串行写队列，避免并发覆盖。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Grant, GrantScope } from '@shared/types';
import { GRANT_CATEGORY_IDS } from '@shared/types';
import { grantKey } from '@shared/proposals/grantKey';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';
import { grantsPath } from '../../runtime/paths';
import { createWriteQueue } from '../../runtime/atomicStore';
import { makeVersionedCodec } from '../../runtime/versionedRecord';
import type { Migration } from '../../runtime/migrateOnRead';
import { quarantineCorrupt } from '../../runtime/storageCorruption';

const { enqueue, writeAtomic } = createWriteQueue();

/**
 * v1→v2：清掉 7/30 审批行为分类改造前的「按站点 web 授权」残留。旧 web_fetch 把「始终允许」按站点
 * 存成 {delivery, channel:'web', recipient: host}；改造后访问网站走 {webAccess} 整类授权（决策 7），
 * 这批旧条目对抓取路径已失效，却残留在设置页「发送内容到外部」清单里误导。bash 网络外发存量的
 * channel:'web' 授权一并清掉——fail-safe 方向：回到弹卡重问，绝不多放行。
 * 迁移只跑一次（v2 文件不再进 chain），改造后新产生的 bash 外发授权不受影响。
 */
const dropLegacyWebSiteGrants: Migration = (prev) => {
  const env = prev as { grants?: unknown };
  // 形状错（grants 非数组）原样交还——doLoad 的类型检查会按损坏隔离；在这兜底成 [] 会把
  // 「隔离留副本」变成「静默抹掉」（回归证据：v1 {grants:'hand-edited'} 曾被直接覆盖）
  if (!Array.isArray(env.grants)) return prev;
  return {
    version: 2,
    grants: env.grants.filter((g) => {
      const s = (g as { scope?: { kind?: unknown; channel?: unknown } } | null)?.scope;
      return !(s?.kind === 'delivery' && s?.channel === 'web');
    }),
  };
};

// v1：`{ version, grants: Grant[] }`；v2：清按站点 web 授权残留（见上）。字段级演进走 sanitize 兜默认。
const codec = makeVersionedCodec<Grant[]>({
  baselineVersion: 1,
  chain: [dropLegacyWebSiteGrants],
  field: 'grants',
  label: 'grants',
});

/** writable:false = 盘上是未来版本文件，本进程不覆盖（版本不倒退），授权仅内存生效。 */
type OwnerState = { grants: Grant[]; writable: boolean };
const cache = new Map<string, OwnerState>();
/**
 * 首载在途 Promise 去重：load 的 cache.set 在所有 await 之后，不去重则并发首载（isGranted 锁外
 * vs addGrant 锁内）会让后完成者拿旧内容顶掉含新授权的 state——内存丢授权，迁移窗口内还可能
 * 把盘回盖成无授权版本（await 后重检共享状态，仓库并发约定）。
 */
const inflight = new Map<string, Promise<OwnerState>>();

function isValidScope(s: unknown): s is GrantScope {
  if (!s || typeof s !== 'object') return false;
  const kind = (s as { kind?: unknown }).kind;
  if (kind === 'destructive' || kind === 'unknown' || kind === 'overwrite') return true;
  if (kind === 'category') {
    const id = (s as { id?: unknown }).id;
    return typeof id === 'string' && (GRANT_CATEGORY_IDS as readonly string[]).includes(id);
  }
  if (kind === 'delivery') {
    const d = s as { channel?: unknown; recipient?: unknown };
    return typeof d.channel === 'string' && typeof d.recipient === 'string';
  }
  return false;
}

/** 防御性：跳过形状不合法的历史条目，不让一条坏记录带崩整份清单。 */
function sanitize(raw: unknown): Grant[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (g): g is Grant =>
      !!g && isValidScope(g.scope) && typeof g.grantedAt === 'number' && typeof g.label === 'string',
  );
}

async function load(ownerId: string): Promise<OwnerState> {
  const cached = cache.get(ownerId);
  if (cached) return cached;
  const pending = inflight.get(ownerId);
  if (pending) return pending;
  const p = doLoad(ownerId).finally(() => inflight.delete(ownerId));
  inflight.set(ownerId, p);
  return p;
}

async function doLoad(ownerId: string): Promise<OwnerState> {
  const f = grantsPath(ownerId);
  let state: OwnerState = { grants: [], writable: true };
  if (existsSync(f)) {
    try {
      const rawText = await fs.readFile(f, 'utf-8');
      const parsed = await codec.read(f, rawText);
      // parsed === null = 未来版本：内存空 + 冻结写盘（对齐 scheduledTasks「不读不写、版本不倒退」）
      if (parsed === null) {
        state = { grants: [], writable: false };
      } else if (!Array.isArray(parsed)) {
        // 合法 JSON 但字段类型错（如手改成字符串）：同 JSON 损坏处理——隔离留副本，不静默覆盖
        await quarantineCorrupt(f, 'grants');
        state = { grants: [], writable: true };
      } else {
        const cleaned = sanitize(parsed);
        state = { grants: cleaned, writable: true };
        // 回盘一次（幂等——回盘后版本齐平、无差异，再加载不再触发写）：sanitize 清了退役/非法条目
        // （旧 {command}，决策 8），或盘上版本落后、chain 跑过迁移（v1→v2 清按站点 web 授权残留）。
        // 直调 persist 不走 enqueue：load 会被 addGrant 的锁内回调调到，再入同一队列会自等死锁。
        // 版本号只能从原信封再 parse 一次取——codec.read 已成功 parse 过同一文本，这里不会再抛。
        const diskVersion = (JSON.parse(rawText) as { version?: unknown }).version;
        if (cleaned.length !== parsed.length || diskVersion !== codec.currentVersion) {
          await persist(ownerId, state);
        }
      }
    } catch {
      // JSON 损坏：隔离原字节（原路径空出可重建）+ 留痕；内存空清单
      await quarantineCorrupt(f, 'grants');
      state = { grants: [], writable: true };
    }
  }
  cache.set(ownerId, state);
  return state;
}

async function persist(ownerId: string, st: OwnerState): Promise<boolean> {
  if (!st.writable) return false; // 未来版本文件在盘：本次仅内存生效，不覆盖
  try {
    await fs.mkdir(dirname(grantsPath(ownerId)), { recursive: true });
    await writeAtomic(grantsPath(ownerId), codec.serialize(st.grants));
    return true;
  } catch (e) {
    console.warn(`[grants] 写盘失败：${String(e)}——本次授权仅内存生效`);
    return false;
  }
}

/** 授权分流判定单源：该 scope 已在清单里则免卡。读内存缓存。 */
export async function isGranted(scope: GrantScope): Promise<boolean> {
  const st = await load(getCurrentOwnerId());
  const key = grantKey(scope);
  return st.grants.some((g) => grantKey(g.scope) === key);
}

/**
 * 记一条持久授权。幂等：同键已存在保留首次 grantedAt、直接返回 persisted:true。
 * 返回 persisted 供 handler 回执——写盘失败时内存已立但盘上未持久，用户不该以为已永久免卡。
 * 入口过 isValidScope：store 是所有写入口（settle / ws grants.add / 未来渠道）的单源，
 * 非法形状（ws 面的垃圾 scope）在此一次全管住，不落盘、按未持久回执。
 */
export async function addGrant(scope: GrantScope, label: string): Promise<{ persisted: boolean }> {
  if (!isValidScope(scope)) {
    console.warn(`[grants] 拒绝非法 scope 授权：${JSON.stringify(scope)}`);
    return { persisted: false };
  }
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const st = await load(ownerId);
    const key = grantKey(scope);
    if (st.grants.some((g) => grantKey(g.scope) === key)) return { persisted: true };
    st.grants.push({ scope, grantedAt: Date.now(), label });
    return { persisted: await persist(ownerId, st) };
  });
}

/** 设置页撤销：该类回到弹卡。找不到该键静默成功（幂等）。 */
export async function revokeGrant(key: string): Promise<void> {
  await enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const st = await load(ownerId);
    const before = st.grants.length;
    st.grants = st.grants.filter((g) => grantKey(g.scope) !== key);
    if (st.grants.length !== before) await persist(ownerId, st);
  });
}

export async function listGrants(): Promise<Grant[]> {
  const st = await load(getCurrentOwnerId());
  return st.grants.map((g) => ({ ...g }));
}

/** 测试 hook：清缓存让下次 load 重读盘。 */
export function __resetGrantsCacheForTest(): void {
  cache.clear();
}
