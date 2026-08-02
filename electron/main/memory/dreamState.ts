/**
 * dream 复盘状态 .dream-state.json 的读写内核。
 *
 * 写归调度器（runOnce 成功后推进 lastDreamAt），读两处共用——调度器的追跑判据
 * 与 dream 拼 prompt 时的时间锚点。抽出来避免读逻辑两份、也让 dream 不必知道 JSON 结构。
 */
import { promises as fs } from 'node:fs';
import { dreamStatePath } from './paths';
import { safeWriteAsync } from '../fs/safeWrite';

/** 读上次复盘时刻 epochMs；文件缺失 / 损坏一律当 0（从没跑过） */
export async function readLastDreamAt(owner: string): Promise<number> {
  try {
    const raw = await fs.readFile(dreamStatePath(owner), 'utf-8');
    const v = (JSON.parse(raw) as { lastDreamAt?: unknown }).lastDreamAt;
    return typeof v === 'number' ? v : 0;
  } catch {
    return 0;
  }
}

/** 原子写上次复盘时刻 */
export async function writeLastDreamAt(owner: string, ts: number): Promise<void> {
  await safeWriteAsync(dreamStatePath(owner), JSON.stringify({ lastDreamAt: ts }));
}
