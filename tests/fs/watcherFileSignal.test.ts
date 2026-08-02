/**
 * G38 外部改动·文件级信号——watcher 对外部程序改动补文件级 fs.changed（带 filePath），
 * 编辑器/预览得以即时命中；目录级消费者（fsStore/tableStore/xlsx 钩子）语义不变（事件仍带 path）。
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Broadcast } from '../../electron/main/ws/server';
import type { FsChangedEvent } from '@shared/protocol';
import { watchDir, unwatchAll, simulateChangeForTest } from '../../electron/main/fs/watcher';

let root: string;
let events: FsChangedEvent[];
const capture: Broadcast = (ev) => {
  if (ev.type === 'fs.changed') events.push(ev);
};

beforeEach(() => {
  vi.useFakeTimers();
  root = mkdtempSync(join(tmpdir(), 'oru-wsig-'));
  mkdirSync(join(root, 'a'), { recursive: true });
  events = [];
});
afterEach(() => {
  unwatchAll();
  vi.useRealTimers();
  rmSync(root, { recursive: true, force: true });
});

describe('G38 watcher 文件级信号', () => {
  it('单文件变更 → 一条文件级事件，带 filePath 与目录级 path', () => {
    watchDir('p1', root, 'a', 'tree', capture);
    simulateChangeForTest('a', 'note.md');
    vi.advanceTimersByTime(300);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ projectId: 'p1', path: 'a', filePath: 'a/note.md' });
  });

  it('同窗口多文件 → 每文件一条（去重合并同名）', () => {
    watchDir('p1', root, 'a', 'tree', capture);
    simulateChangeForTest('a', 'x.md');
    simulateChangeForTest('a', 'y.md');
    simulateChangeForTest('a', 'x.md'); // 同名合并
    vi.advanceTimersByTime(300);
    const paths = events.map((e) => e.filePath).sort();
    expect(paths).toEqual(['a/x.md', 'a/y.md']);
  });

  it('根目录变更 → filePath 无前缀斜杠、path=""', () => {
    watchDir('p1', root, '', 'tree', capture);
    simulateChangeForTest('', 'top.txt');
    vi.advanceTimersByTime(300);
    expect(events[0]).toMatchObject({ path: '', filePath: 'top.txt' });
  });

  it('filename 为 null（个别平台）→ 退回目录级事件（无 filePath）', () => {
    watchDir('p1', root, 'a', 'tree', capture);
    simulateChangeForTest('a', null);
    vi.advanceTimersByTime(300);
    expect(events).toHaveLength(1);
    expect(events[0].filePath).toBeUndefined();
    expect(events[0].path).toBe('a');
  });

  it('作者标缺省（外部改动来源未知）', () => {
    watchDir('p1', root, 'a', 'tree', capture);
    simulateChangeForTest('a', 'z.md');
    vi.advanceTimersByTime(300);
    expect(events[0].author).toBeUndefined();
  });
});
