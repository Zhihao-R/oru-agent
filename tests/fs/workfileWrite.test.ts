/**
 * commitWorkfileWrite 路径规范化回归（review C-1）。
 *
 * 用户侧（ensureWithinProject 已 resolve）与 AI 侧（模型给的原始绝对路径，可能含 ./ ../）必须归一到
 * 同一把锁 / 同一 history 目录——否则同一文件被劈成两份，「用户落盘 ↔ AI 写不丢」漏抓。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-workfilewrite-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;
const PROJECT = join(ORU_DIR, 'project');

let commitWorkfileWrite!: typeof import('../../electron/main/fs/workfileWrite').commitWorkfileWrite;
let FH!: typeof import('../../electron/main/fs/fileHistory');

beforeAll(async () => {
  await fs.mkdir(join(PROJECT, 'sub'), { recursive: true });
  ({ commitWorkfileWrite } = await import('../../electron/main/fs/workfileWrite'));
  FH = await import('../../electron/main/fs/fileHistory');
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

describe('路径规范化（C-1）', () => {
  it('规范路径与非规范路径（./ 、..）落到同一把锁 / 同一历史，不丢中间版', async () => {
    const canonical = join(PROJECT, 'a.md');
    const viaDot = join(PROJECT, '.', 'a.md'); // /proj/./a.md
    const viaParent = join(PROJECT, 'sub', '..', 'a.md'); // /proj/sub/../a.md

    await commitWorkfileWrite({ absPath: canonical, content: 'V1' });
    await commitWorkfileWrite({ absPath: viaDot, content: 'V2' }); // 覆盖前应把 V1 兜进历史
    await commitWorkfileWrite({ absPath: viaParent, content: 'V3' }); // 覆盖前应把 V2 兜进历史

    expect(await fs.readFile(canonical, 'utf-8')).toBe('V3'); // 三次都写的是同一个文件
    // 三种写法寻址到同一 history：列出任意一种都应看到被覆盖的 V1、V2
    const snaps = await FH.list(viaParent);
    const contents = await Promise.all(snaps.map((s) => FH.restore(canonical, s.id)));
    expect(contents).toContain('V1');
    expect(contents).toContain('V2');
  });

  it('并发非规范路径写串行化在同一把锁（无丢版本）', async () => {
    const canonical = join(PROJECT, 'b.md');
    await commitWorkfileWrite({ absPath: canonical, content: 'base' });
    await Promise.all([
      commitWorkfileWrite({ absPath: join(PROJECT, 'b.md'), content: 'X', mark: 'manual' }),
      commitWorkfileWrite({ absPath: join(PROJECT, '.', 'b.md'), content: 'Y', mark: 'ai' }),
    ]);
    const final = await fs.readFile(canonical, 'utf-8');
    const snaps = await FH.list(canonical);
    const contents = await Promise.all(snaps.map((s) => FH.restore(canonical, s.id)));
    expect(contents).toContain('base');
    // 被后写者覆盖的那一版应在历史里（X/Y 串行，先写的被兜底）
    const overwritten = ['X', 'Y'].filter((v) => v !== final);
    for (const v of overwritten) expect(contents).toContain(v);
  });
});

describe('S02 · G88 锁内基线校验（baseline / expectAbsent）', () => {
  it('baseline 与磁盘现状相符 → written，内容更新', async () => {
    const p = join(PROJECT, 'g88-ok.md');
    await commitWorkfileWrite({ absPath: p, content: '读到的版本' });
    const r = await commitWorkfileWrite({
      absPath: p,
      content: '新版本',
      mark: 'ai',
      baseline: { content: '读到的版本' },
    });
    expect(r).toEqual({ status: 'written' });
    expect(await fs.readFile(p, 'utf-8')).toBe('新版本');
  });

  it('baseline 不符（外部已改）→ rejected baseline-mismatch，磁盘一字不动', async () => {
    const p = join(PROJECT, 'g88-moved.md');
    await commitWorkfileWrite({ absPath: p, content: '用户最新版' });
    const r = await commitWorkfileWrite({
      absPath: p,
      content: 'AI 基于旧认知的版本',
      mark: 'ai',
      baseline: { content: 'AI 读到的旧版' },
    });
    expect(r).toEqual({ status: 'rejected', reason: 'baseline-mismatch' });
    expect(await fs.readFile(p, 'utf-8')).toBe('用户最新版');
  });

  it('baseline 给了但文件已被删除 → baseline-mismatch（认知过期，退回重读）', async () => {
    const p = join(PROJECT, 'g88-gone.md');
    const r = await commitWorkfileWrite({
      absPath: p,
      content: '任意',
      baseline: { content: '读到过的内容' },
    });
    expect(r).toEqual({ status: 'rejected', reason: 'baseline-mismatch' });
    expect(await fs.stat(p).catch(() => null)).toBeNull();
  });

  it('expectAbsent 且目标已被占（审批窗口内被创建）→ path-occupied，不覆盖', async () => {
    const p = join(PROJECT, 'g88-occupied.md');
    await fs.writeFile(p, '别人先写的');
    const r = await commitWorkfileWrite({ absPath: p, content: '新建内容', expectAbsent: true });
    expect(r).toEqual({ status: 'rejected', reason: 'path-occupied' });
    expect(await fs.readFile(p, 'utf-8')).toBe('别人先写的');
  });

  it('attacker：两个写者持同一 baseline 并发 → 恰一个 written、另一个锁内被拒（锁外判定不作数）', async () => {
    const p = join(PROJECT, 'g88-race.md');
    await commitWorkfileWrite({ absPath: p, content: 'base' });
    const results = await Promise.all([
      commitWorkfileWrite({ absPath: p, content: '甲的版本', baseline: { content: 'base' } }),
      commitWorkfileWrite({ absPath: p, content: '乙的版本', baseline: { content: 'base' } }),
    ]);
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual(['rejected', 'written']);
  });

  it('不传 baseline/expectAbsent 的既有调用方零变化：恒 written、last-writer-wins', async () => {
    const p = join(PROJECT, 'g88-legacy.md');
    await commitWorkfileWrite({ absPath: p, content: 'v1' });
    const r = await commitWorkfileWrite({ absPath: p, content: 'v2' });
    expect(r).toEqual({ status: 'written' });
    expect(await fs.readFile(p, 'utf-8')).toBe('v2');
  });
});
