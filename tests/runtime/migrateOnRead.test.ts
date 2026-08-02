/**
 * 读时 schema 迁移执行器（D5）单测——覆盖 docs/tech/2026-06-24-d5-*.md §4 的全部判据。
 */
import { describe, it, expect } from 'vitest';
import { migrateOnRead, type Migration } from '../../electron/main/runtime/migrateOnRead';

// 一条示例链：v1 加 name 字段 → v2 把 name 拆成 first/last → 每步写回 version。
const chain: ReadonlyArray<Migration> = [
  (prev) => ({ ...(prev as object), version: 2, name: (prev as { name?: string }).name ?? '佚名' }),
  (prev) => {
    const p = prev as { name: string };
    const [first, last = ''] = p.name.split(' ');
    return { ...p, version: 3, first, last };
  },
];
const BASELINE = 1;

describe('migrateOnRead', () => {
  it('无 version 旧 fixture → 跑完整条链到最新形态', () => {
    const out = migrateOnRead<{ version: number; first: string; last: string }>(
      { name: 'Ada Lovelace' },
      chain,
      BASELINE,
    );
    expect(out.version).toBe(3);
    expect(out.first).toBe('Ada');
    expect(out.last).toBe('Lovelace');
  });

  it('当前版本 fixture → 链 0 次执行（幂等、不动新数据）', () => {
    const current = { version: 3, name: 'X', first: 'X', last: '' };
    const out = migrateOnRead<typeof current>(current, chain, BASELINE);
    expect(out).toEqual(current); // 原样返回，未被任何 migration 改写
  });

  it('中间态（version=baseline+1）→ 只跑后续跳、不重跑 chain[0]（防双重迁移）', () => {
    // 已是 v2（有 name、无 first/last）。只该跑 chain[1]（v2→v3），不该再跑 chain[0]。
    const out = migrateOnRead<{ version: number; first: string }>(
      { version: 2, name: 'Grace Hopper' },
      chain,
      BASELINE,
    );
    expect(out.version).toBe(3);
    expect(out.first).toBe('Grace'); // chain[1] 跑了
  });

  it('baseline≠1 → 无 version 老文件按传入 baseline 起跳', () => {
    // baseline=5、单步链（v5→v6）。无 version 老文件视作 v5，跑该步。
    const out = migrateOnRead<{ version: number; tag: string }>(
      { x: 1 },
      [(prev) => ({ ...(prev as object), version: 6, tag: 'migrated' })],
      5,
    );
    expect(out.version).toBe(6);
    expect(out.tag).toBe('migrated');
  });

  it('version > current → 原样返回，不降级', () => {
    const future = { version: 99, foo: 'bar' };
    const out = migrateOnRead<typeof future>(future, chain, BASELINE);
    expect(out).toEqual(future);
  });

  it('非整数 / 低于 baseline 的 version → 显式抛（防静默全链重跑或负数索引 chain 崩 TypeError）', () => {
    expect(() => migrateOnRead({ version: '2' }, chain, BASELINE)).toThrow(/version 字段非法/);
    expect(() => migrateOnRead({ version: 2.5 }, chain, BASELINE)).toThrow(/version 字段非法/);
    expect(() => migrateOnRead({ version: -1 }, chain, BASELINE)).toThrow(/version 字段非法/);
    expect(() => migrateOnRead({ version: 0 }, chain, BASELINE)).toThrow(/version 字段非法/); // < baseline(1)
  });
});
