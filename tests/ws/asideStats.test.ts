/**
 * 随手评点的朴素本地计数（二期 §8）——仿 accessLog：JSON 单文件 + batched flush，
 * 无 UI、无上报、纯本地，只为三期调什么有数可看。
 *
 * 事件→指标映射写死（capture 不能当 ⌥ 点的代理——deck 截图不经 aside.capture）：
 * ⌥ 点次数 = comments + addReferents；开口 = begins；转正 = promotes。
 * 按本地日期分桶——开口率 / 转正率 / 「点过的人还来不来点」都从日桶推导。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ORU_DIR = join(tmpdir(), `oru-test-aside-stats-${Date.now()}`);
process.env.ORU_DIR = ORU_DIR;

const OWNER = 'local-user';

beforeAll(async () => {
  await fs.mkdir(ORU_DIR, { recursive: true });
});

afterAll(async () => {
  await fs.rm(ORU_DIR, { recursive: true, force: true });
});

afterEach(async () => {
  const { __resetForTest } = await import('../../electron/main/ws/aside/stats');
  __resetForTest();
  await fs.rm(join(ORU_DIR, 'users', OWNER, 'aside-stats.json'), { force: true });
});

async function readStatsFile(): Promise<Record<string, Record<string, number>>> {
  const text = await fs.readFile(join(ORU_DIR, 'users', OWNER, 'aside-stats.json'), 'utf-8');
  return JSON.parse(text);
}

describe('recordAsideEvent', () => {
  it('四类事件按日分桶计数，flush 后落盘', async () => {
    const { recordAsideEvent, flushAsideStats } = await import(
      '../../electron/main/ws/aside/stats'
    );
    const at = new Date(2026, 5, 11, 10, 0, 0).getTime(); // 本地 2026-06-11
    await recordAsideEvent(OWNER, 'comment', at);
    await recordAsideEvent(OWNER, 'comment', at);
    await recordAsideEvent(OWNER, 'addReferent', at);
    await recordAsideEvent(OWNER, 'begin', at);
    await recordAsideEvent(OWNER, 'promote', at);
    await flushAsideStats();

    const data = await readStatsFile();
    expect(data['2026-06-11']).toEqual({
      comments: 2,
      addReferents: 1,
      begins: 1,
      promotes: 1,
      screenComments: 0,
      screenAddReferents: 0,
      screenBegins: 0,
      screenPromotes: 0,
    });
  });

  it('窗外（screen）来源：总量与窗外子集同时计，窗内 = 总量 − 窗外', async () => {
    const { recordAsideEvent, flushAsideStats } = await import(
      '../../electron/main/ws/aside/stats'
    );
    const at = new Date(2026, 5, 11, 10, 0, 0).getTime();
    await recordAsideEvent(OWNER, 'comment', at, 'window'); // 窗内
    await recordAsideEvent(OWNER, 'comment', at, 'screen'); // 窗外
    await recordAsideEvent(OWNER, 'begin', at, 'screen'); // 窗外开口
    await recordAsideEvent(OWNER, 'promote', at); // 默认窗内
    await flushAsideStats();

    const b = (await readStatsFile())['2026-06-11'];
    // 总量含窗内 + 窗外
    expect(b.comments).toBe(2);
    expect(b.begins).toBe(1);
    expect(b.promotes).toBe(1);
    // 窗外子集只数 screen 来源
    expect(b.screenComments).toBe(1);
    expect(b.screenBegins).toBe(1);
    expect(b.screenPromotes).toBe(0); // promote 走默认窗内
    // 窗内 = 总量 − 窗外
    expect(b.comments - b.screenComments).toBe(1);
  });

  it('跨日各归各桶；已有文件累加不覆盖', async () => {
    const { recordAsideEvent, flushAsideStats, __resetForTest } = await import(
      '../../electron/main/ws/aside/stats'
    );
    const day1 = new Date(2026, 5, 11, 23, 59).getTime();
    const day2 = new Date(2026, 5, 12, 0, 1).getTime();
    await recordAsideEvent(OWNER, 'comment', day1);
    await flushAsideStats();
    // 模拟重启：清内存缓存后再记 → 必须读回老数据累加
    __resetForTest();
    await recordAsideEvent(OWNER, 'comment', day1);
    await recordAsideEvent(OWNER, 'begin', day2);
    await flushAsideStats();

    const data = await readStatsFile();
    expect(data['2026-06-11'].comments).toBe(2);
    expect(data['2026-06-12'].begins).toBe(1);
  });

  it('flush 前不写盘（batched）；flushAll 兜底', async () => {
    const { recordAsideEvent, flushAsideStats } = await import(
      '../../electron/main/ws/aside/stats'
    );
    await recordAsideEvent(OWNER, 'comment');
    await expect(readStatsFile()).rejects.toThrow(); // 10s 批量窗口内不落盘
    await flushAsideStats();
    const data = await readStatsFile();
    const days = Object.keys(data);
    expect(days).toHaveLength(1);
    expect(data[days[0]].comments).toBe(1);
  });
});
