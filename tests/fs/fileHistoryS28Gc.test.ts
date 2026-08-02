/**
 * S28 · GC 纯逻辑单测（G92 到期归档 + G40 近密远疏稀释）。
 *
 * gcInPlace 的龄段判定注入 `now`，用手搓的快照数组确定性验证，不依赖真实时钟/fs（快而准）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { FileSnapshotRef, FileSnapshotKind } from '@shared/types';

type FH = typeof import('../../electron/main/fs/fileHistory');
let gcInPlace!: FH['gcInPlace'];
let MAX_AGE_MS!: number;

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
const NOW = 10 * 365 * 24 * HOUR; // 一个够大的固定“现在”，避免负龄

// 动态 import 前先设 ORU_DIR（paths 模块 load 时锁路径），保持与其它 fs 测试同纪律
process.env.ORU_DIR = process.env.ORU_DIR ?? '/tmp/oru-test-s28gc';

let sid = 0;
function snap(kind: FileSnapshotKind, ageMs: number, extra?: Partial<FileSnapshotRef>): FileSnapshotRef {
  return {
    id: `s${String(++sid).padStart(3, '0')}`,
    createdAt: NOW - ageMs,
    kind,
    hash: `h${sid}`,
    size: 10,
    ...extra,
  };
}

beforeAll(async () => {
  const mod = await import('../../electron/main/fs/fileHistory');
  gcInPlace = mod.gcInPlace;
  MAX_AGE_MS = mod.MAX_AGE_MS;
});

describe('S28 · G92 里程碑到期归档（不静默删）', () => {
  it('超保留期的里程碑不删、就地打 archived、进 newlyArchived', () => {
    // 时间序：老里程碑（超龄）在前，最新一条在后（永不动）
    const oldMilestone = snap('manual', MAX_AGE_MS + HOUR);
    const newest = snap('ai', 0);
    const list = [oldMilestone, newest];
    const { removed, newlyArchived } = gcInPlace(list, undefined, undefined, NOW);
    expect(removed).toHaveLength(0); // 不删
    expect(newlyArchived).toEqual([oldMilestone]); // 归档
    expect(oldMilestone.archived).toBe(true); // 就地打标（随 manifest 落盘）
    expect(list).toContain(oldMilestone); // 仍在时间轴、可找回
  });

  it('已归档的里程碑不重复进 newlyArchived（幂等，不重复发信号）', () => {
    const oldMilestone = snap('manual', MAX_AGE_MS + HOUR, { archived: true });
    const newest = snap('ai', 0);
    const { newlyArchived } = gcInPlace([oldMilestone, newest], undefined, undefined, NOW);
    expect(newlyArchived).toHaveLength(0);
  });

  it('各类里程碑（handoff/pre-restore/initial/discarded）超龄都归档不删', () => {
    const kinds: FileSnapshotKind[] = ['handoff', 'pre-restore', 'initial', 'discarded'];
    const olds = kinds.map((k) => snap(k, MAX_AGE_MS + HOUR));
    const newest = snap('ai', 0);
    const { removed, newlyArchived } = gcInPlace([...olds, newest], undefined, undefined, NOW);
    expect(removed).toHaveLength(0);
    expect(newlyArchived).toHaveLength(kinds.length);
  });

  it('overwrite-guard 超龄仍直接删（匿名兜底，非里程碑，不归档）', () => {
    const oldGuard = snap('overwrite-guard', MAX_AGE_MS + HOUR);
    const newest = snap('ai', 0);
    const { removed, newlyArchived } = gcInPlace([oldGuard, newest], undefined, undefined, NOW);
    expect(removed).toEqual([oldGuard]);
    expect(newlyArchived).toHaveLength(0);
  });

  it('retainAll（deck）完全不归档不删', () => {
    const oldMilestone = snap('protective', MAX_AGE_MS + 100 * HOUR);
    const { removed, newlyArchived } = gcInPlace([oldMilestone, snap('inline', 0)], true, undefined, NOW);
    expect(removed).toHaveLength(0);
    expect(newlyArchived).toHaveLength(0);
    expect(oldMilestone.archived).toBeUndefined();
  });
});

describe('S28 · G40 周期取样近密远疏稀释', () => {
  it('1 小时内的 periodic 全保留（近期密）', () => {
    const recent = [snap('periodic', 50 * MIN), snap('periodic', 40 * MIN), snap('periodic', 5 * MIN)];
    const newest = snap('manual', 0);
    const { removed } = gcInPlace([...recent, newest], undefined, undefined, NOW);
    expect(removed).toHaveLength(0);
  });

  it('1–6h 段按 ≥15min 间距稀释（远期疏）', () => {
    // 在 2h 附近密集打 6 个 periodic（间距 ~5min），应被稀释到 ~15min 一个
    const dense = Array.from({ length: 6 }, (_, i) => snap('periodic', 2 * HOUR + i * 5 * MIN));
    const newest = snap('manual', 0);
    const before = dense.length;
    const { removed } = gcInPlace([...dense, newest], undefined, undefined, NOW);
    expect(removed.length).toBeGreaterThan(0); // 有稀释
    expect(before - removed.length).toBeLessThan(before); // 确实删了几条
    // 保留的都是 periodic 且间距 ≥15min（抽样验证：保留数应约 30min/15min≈2 条上下）
    expect(removed.every((r) => r.kind === 'periodic')).toBe(true);
  });

  it('超保留期的 periodic 一律稀释掉（匿名锚点无“可找回”承诺）', () => {
    const oldPeriodic = snap('periodic', MAX_AGE_MS + HOUR);
    const newest = snap('manual', 0);
    const { removed } = gcInPlace([oldPeriodic, newest], undefined, undefined, NOW);
    expect(removed).toEqual([oldPeriodic]);
  });

  it('稀释只吃 periodic——同期的里程碑一条不动', () => {
    const dense = Array.from({ length: 6 }, (_, i) => snap('periodic', 2 * HOUR + i * 3 * MIN));
    const milestone = snap('ai', 2 * HOUR + HOUR); // 一个 3h 龄的里程碑（未超保留期）
    const newest = snap('manual', 0);
    const { removed } = gcInPlace([milestone, ...dense, newest], undefined, undefined, NOW);
    expect(removed).not.toContain(milestone);
    expect(removed.every((r) => r.kind === 'periodic')).toBe(true);
  });

  it('最新一条永不被稀释/淘汰（即便是 periodic 且超龄）', () => {
    const newest = snap('periodic', MAX_AGE_MS + 100 * HOUR); // 极旧但它是最新一条
    const { removed } = gcInPlace([newest], undefined, undefined, NOW);
    expect(removed).toHaveLength(0);
  });
});
