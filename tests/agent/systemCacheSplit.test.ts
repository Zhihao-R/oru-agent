/**
 * 两层缓存切分（Task 3 · 快照进缓存）—— 纯函数，验证 system 段如何切成可缓存/动态。
 *
 * 关键不变量：
 * - 单层退化：不传 sessionStable 时，行为与旧 splitSystemForCache 完全一致（mid 空）——
 *   保证子 agent（只传 stable）路径分毫不变。
 * - 两层：sessionStable = stable + 会话级稳定内容（能力 prompt + 记忆快照）时，
 *   切出 stable / mid / dynamic 三段，前两段各打一个缓存点 → 主对话快照被缓存、
 *   且 stable 段仍独立可缓存（子 agent 继续复用它）。
 * - 前缀关系任一不成立（编程错误）→ 优雅退化，不破坏请求。
 */
import { describe, it, expect } from 'vitest';
import {
  splitSystemForTwoTierCache,
  cachedSystemSegments,
} from '../../electron/main/agent/backends/systemCacheSplit';

const SEP = '\n\n---\n\n';
const STABLE = '人设：我是 Twin';
const EXTRA = `${SEP}能力：联网${SEP}记忆快照：用户叫阮子`;
const DYN = `${SEP}当前时间：2026-06-02`;
const SESSION = STABLE + EXTRA;
const FULL = SESSION + DYN;

describe('splitSystemForTwoTierCache', () => {
  it('两层：切出 stable / sessionExtra / dynamic，三段可拼回 full', () => {
    const r = splitSystemForTwoTierCache(FULL, STABLE, SESSION);
    expect(r.stable).toBe(STABLE);
    expect(r.sessionExtra).toBe(EXTRA);
    expect(r.dynamic).toBe(DYN);
    expect(r.stable + r.sessionExtra + r.dynamic).toBe(FULL);
  });

  it('单层退化：不传 sessionStable → sessionExtra 空，等价旧单层切分', () => {
    const r = splitSystemForTwoTierCache(FULL, STABLE, undefined);
    expect(r.stable).toBe(STABLE);
    expect(r.sessionExtra).toBe('');
    expect(r.dynamic).toBe(EXTRA + DYN); // 旧行为：stable 之后全是 dynamic
  });

  it('sessionStable === stable → sessionExtra 空（无额外可缓存内容）', () => {
    const r = splitSystemForTwoTierCache(FULL, STABLE, STABLE);
    expect(r.sessionExtra).toBe('');
    expect(r.dynamic).toBe(EXTRA + DYN);
  });

  it('stable 为空 → 整段动态', () => {
    const r = splitSystemForTwoTierCache(FULL, '', SESSION);
    expect(r).toEqual({ stable: '', sessionExtra: '', dynamic: FULL });
  });

  it('full 不以 stable 开头（编程错误）→ 整段动态，不抛', () => {
    const r = splitSystemForTwoTierCache(FULL, '别的前缀', SESSION);
    expect(r).toEqual({ stable: '', sessionExtra: '', dynamic: FULL });
  });

  it('sessionStable 不以 stable 开头（编程错误）→ 退回单层，sessionExtra 空', () => {
    const r = splitSystemForTwoTierCache(FULL, STABLE, '不含 stable 的串');
    expect(r.stable).toBe(STABLE);
    expect(r.sessionExtra).toBe('');
    expect(r.dynamic).toBe(EXTRA + DYN);
  });

  it('full 不以 sessionStable 开头（编程错误）→ 退回单层，sessionExtra 空', () => {
    const weirdSession = STABLE + SEP + '快照里有 full 没有的内容';
    const r = splitSystemForTwoTierCache(FULL, STABLE, weirdSession);
    expect(r.stable).toBe(STABLE);
    expect(r.sessionExtra).toBe('');
    expect(r.dynamic).toBe(EXTRA + DYN);
  });

  it('能力段为空（runner filter 掉中段）→ 前缀关系仍成立，正常切两层', () => {
    // 模拟 runner：capability 空时 sessionStable = stable+SEP+snapshot，full = 同 + SEP+runtime
    const snapshot = `${SEP}记忆快照：用户叫阮子`;
    const session = STABLE + snapshot;
    const full = session + DYN;
    const r = splitSystemForTwoTierCache(full, STABLE, session);
    expect(r.stable).toBe(STABLE);
    expect(r.sessionExtra).toBe(snapshot);
    expect(r.dynamic).toBe(DYN);
  });
});

describe('cachedSystemSegments', () => {
  it('两层 → 三段：stable(cached) + sessionExtra(cached) + dynamic(未缓存)', () => {
    const segs = cachedSystemSegments(FULL, STABLE, SESSION);
    expect(segs).toEqual([
      { text: STABLE, cached: true },
      { text: EXTRA, cached: true },
      { text: DYN, cached: false },
    ]);
    // 两个缓存点 = 两个 cached 段
    expect(segs.filter((s) => s.cached)).toHaveLength(2);
  });

  it('单层（子 agent 路径，不传 sessionStable）→ 两段：stable(cached) + dynamic', () => {
    const segs = cachedSystemSegments(FULL, STABLE, undefined);
    expect(segs).toEqual([
      { text: STABLE, cached: true },
      { text: EXTRA + DYN, cached: false },
    ]);
    expect(segs.filter((s) => s.cached)).toHaveLength(1);
  });

  it('无可缓存 stable → 单段全量未缓存（调用方据此退回纯字符串）', () => {
    const segs = cachedSystemSegments(FULL, '', SESSION);
    expect(segs).toEqual([{ text: FULL, cached: false }]);
  });

  it('sessionExtra 为空不产生空缓存段', () => {
    const segs = cachedSystemSegments(FULL, STABLE, STABLE);
    expect(segs.some((s) => s.text === '')).toBe(false);
  });
});
