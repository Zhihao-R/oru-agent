/**
 * 调试日志 7 天留存：
 * - selectExpiredDebugDayDirs 纯函数——挑出过期天目录，边界=保留今天+前 6 天
 * - sweepExpiredDebugDays——真删磁盘上的过期天目录，非日期条目不碰，root 不存在不抛
 *
 * beginRound 换日触发在 retentionTrigger.test.ts（需要 vi.mock 本模块，不能同文件）。
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  selectExpiredDebugDayDirs,
  sweepExpiredDebugDays,
} from '../../electron/main/debug/retention';

/** 2026-07-28 12:00 本地时间 */
const NOW = new Date(2026, 6, 28, 12, 0, 0).getTime();

describe('selectExpiredDebugDayDirs', () => {
  it('保留今天+前 6 天，更早的判过期', () => {
    const entries = [
      '2026-07-28', // 今天
      '2026-07-22', // 今天-6，第 7 天，保留边界
      '2026-07-21', // 今天-7，过期
      '2026-07-01', // 过期
    ];
    expect(selectExpiredDebugDayDirs(entries, NOW).sort()).toEqual(['2026-07-01', '2026-07-21']);
  });

  it('非日期形态的条目从不判过期', () => {
    const entries = ['.DS_Store', 'notes.txt', '2026-7-1', '2026-07-21'];
    expect(selectExpiredDebugDayDirs(entries, NOW)).toEqual(['2026-07-21']);
  });

  it('跨月/跨年边界按真实日历算', () => {
    // 2027-01-02 的前 6 天是 2026-12-27
    const now = new Date(2027, 0, 2, 12, 0, 0).getTime();
    const entries = ['2026-12-27', '2026-12-26', '2027-01-02'];
    expect(selectExpiredDebugDayDirs(entries, now)).toEqual(['2026-12-26']);
  });
});

describe('sweepExpiredDebugDays', () => {
  it('删过期天目录（含内容），保留近 7 天目录与非日期条目', async () => {
    const root = mkdtempSync(join(tmpdir(), 'oru-debug-retention-'));
    for (const day of ['2026-07-28', '2026-07-22', '2026-07-21', '2026-07-01']) {
      await fs.mkdir(join(root, day), { recursive: true });
      await fs.writeFile(join(root, day, 'conversation-c1.ndjson'), '{}\n');
    }
    await fs.writeFile(join(root, '.DS_Store'), '');

    await sweepExpiredDebugDays(root, NOW);

    const left = (await fs.readdir(root)).sort();
    expect(left).toEqual(['.DS_Store', '2026-07-22', '2026-07-28']);
  });

  it('root 不存在时静默返回', async () => {
    await expect(
      sweepExpiredDebugDays(join(tmpdir(), 'oru-debug-retention-nonexistent'), NOW),
    ).resolves.toBeUndefined();
  });
});
