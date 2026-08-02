/**
 * 行为收紧覆盖（2026-07-31 PM 拍板：策略表双向开关）——「默认不问的行被用户拨成每次问」的行 id 集。
 * 落盘：~/.oru/users/<ownerId>/behavior-policy.json，单文件封套 `{ version, askRows: string[] }`。
 *
 * 与 grants 互补：grants 记「免卡」（放行向），本 store 记「重问」（收紧向）——默认不问的行
 * （create/modify/aiOwned）没有可授权的 scope，收紧向无法复用 grants 表达，故单列一份。
 * 白名单即注册表里 askable 的行（behaviors.ts 单源），非法行 id 在写入口一次全管住。
 *
 * 运行时消费点：emitProposal（提案类行为：create/modify 弹卡）与 writeFile（aiOwned 关掉 D3 免审）。
 * 骨架对齐 grants store：串行写队列 + 原子写 + 损坏隔离 + 首载在途去重 + 写盘失败如实回执。
 */
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { APPROVAL_BEHAVIOR_ROWS } from '@shared/proposals/behaviors';
import { getCurrentOwnerId } from '../../identity/getCurrentOwnerId';
import { behaviorPolicyPath } from '../../runtime/paths';
import { createWriteQueue } from '../../runtime/atomicStore';
import { makeVersionedCodec } from '../../runtime/versionedRecord';
import { quarantineCorrupt } from '../../runtime/storageCorruption';

const { enqueue, writeAtomic } = createWriteQueue();

const codec = makeVersionedCodec<string[]>({
  baselineVersion: 1,
  chain: [],
  field: 'askRows',
  label: 'behaviorPolicy',
});

/** 可被收紧的行 id 白名单——注册表 askable 标记是唯一事实源。 */
const ASKABLE_ROW_IDS = new Set(APPROVAL_BEHAVIOR_ROWS.filter((r) => r.askable).map((r) => r.id));

export function isAskableRow(rowId: string): boolean {
  return ASKABLE_ROW_IDS.has(rowId);
}

/** writable:false = 盘上是未来版本文件，本进程不覆盖（版本不倒退），覆盖仅内存生效。 */
type OwnerState = { askRows: string[]; writable: boolean };
const cache = new Map<string, OwnerState>();
// 首载在途 Promise 去重（同 grants store：不去重则并发首载会让后完成者拿旧内容顶掉新 state）
const inflight = new Map<string, Promise<OwnerState>>();

/** 防御性：跳过非字符串 / 非白名单的历史条目，不让一条坏记录带崩整份清单。 */
function sanitize(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is string => typeof r === 'string' && ASKABLE_ROW_IDS.has(r));
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
  const f = behaviorPolicyPath(ownerId);
  let state: OwnerState = { askRows: [], writable: true };
  if (existsSync(f)) {
    try {
      const parsed = await codec.read(f, await fs.readFile(f, 'utf-8'));
      if (parsed === null) {
        state = { askRows: [], writable: false }; // 未来版本：内存空 + 冻结写盘
      } else if (!Array.isArray(parsed)) {
        // 合法 JSON 但字段类型错：同 JSON 损坏处理——隔离留副本，不静默覆盖
        await quarantineCorrupt(f, 'behaviorPolicy');
        state = { askRows: [], writable: true };
      } else {
        const cleaned = sanitize(parsed);
        state = { askRows: cleaned, writable: true };
        // 失效条目（行从注册表 askable 除名）被 sanitize 清掉时回盘一次（对齐 grants 决策 8 惯例，
        // 幂等）。直调 persist 不走 enqueue：load 会被 setAskOverridden 的锁内回调调到，再入同一
        // 队列会自等死锁。
        if (cleaned.length !== parsed.length) await persist(ownerId, state);
      }
    } catch {
      // JSON 损坏：隔离原字节（原路径空出可重建）+ 留痕；内存空清单
      await quarantineCorrupt(f, 'behaviorPolicy');
      state = { askRows: [], writable: true };
    }
  }
  cache.set(ownerId, state);
  return state;
}

async function persist(ownerId: string, st: OwnerState): Promise<boolean> {
  if (!st.writable) return false; // 未来版本文件在盘：本次仅内存生效，不覆盖
  try {
    await fs.mkdir(dirname(behaviorPolicyPath(ownerId)), { recursive: true });
    await writeAtomic(behaviorPolicyPath(ownerId), codec.serialize(st.askRows));
    return true;
  } catch (e) {
    console.warn(`[behaviorPolicy] 写盘失败：${String(e)}——本次覆盖仅内存生效`);
    return false;
  }
}

/** 该行是否被用户拨成「每次问」。读内存缓存。 */
export async function isAskOverridden(rowId: string): Promise<boolean> {
  const st = await load(getCurrentOwnerId());
  return st.askRows.includes(rowId);
}

/**
 * 设置/取消一行的「每次问」覆盖。幂等：状态无变化直接返回 persisted:true。
 * 入口过白名单：store 是所有写入口的单源，非法行 id（ws 面垃圾）不落盘、按未持久回执。
 */
export async function setAskOverridden(rowId: string, ask: boolean): Promise<{ persisted: boolean }> {
  if (!ASKABLE_ROW_IDS.has(rowId)) {
    console.warn(`[behaviorPolicy] 拒绝非法行覆盖：${rowId}`);
    return { persisted: false };
  }
  return enqueue(async () => {
    const ownerId = getCurrentOwnerId();
    const st = await load(ownerId);
    const has = st.askRows.includes(rowId);
    if (has === ask) return { persisted: true };
    st.askRows = ask ? [...st.askRows, rowId] : st.askRows.filter((r) => r !== rowId);
    return { persisted: await persist(ownerId, st) };
  });
}

export async function listAskOverrides(): Promise<string[]> {
  const st = await load(getCurrentOwnerId());
  return [...st.askRows];
}

/** 测试 hook：清缓存让下次 load 重读盘。 */
export function __resetBehaviorPolicyCacheForTest(): void {
  cache.clear();
}
