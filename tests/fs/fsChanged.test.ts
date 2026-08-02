/**
 * fileChangedEvent —— 单文件落盘的统一变更事件构造（块①「统一通知」）。
 *
 * 同时带目录级 `path`（旧消费者 fsStore/tableStore 按目录消费，语义不变）与
 * 文件级 `filePath`（协同接收方按此精确命中）。用户侧落盘与 AI 侧落盘共用一处，
 * 保证两条路径产出同形态事件（系统性：旧语义不动、新能力走新字段）。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FsChangedEvent } from '@shared/protocol';

// broadcastFileChanged 依赖：projects 反查（绝对路径→项目）+ ws 广播。两者 mock 掉，只验 AI 侧接线。
const findProjectByPath = vi.fn();
vi.mock('../../electron/main/projects/store', () => ({
  findProjectByPath: (...a: unknown[]) => findProjectByPath(...a),
}));
const broadcast = vi.fn();
vi.mock('../../electron/main/ws/server', () => ({
  broadcast: (...a: unknown[]) => broadcast(...a),
}));

import { fileChangedEvent, broadcastFileChanged } from '../../electron/main/fs/fsChanged';

afterEach(() => {
  findProjectByPath.mockReset();
  broadcast.mockReset();
});

describe('fileChangedEvent', () => {
  it('顶层文件：path 为项目根（空串），filePath 为文件本身', () => {
    expect(fileChangedEvent('prj_1', 'a.md')).toEqual({
      type: 'fs.changed',
      projectId: 'prj_1',
      path: '',
      filePath: 'a.md',
    });
  });

  it('嵌套文件：path 为父目录，filePath 为项目相对全路径', () => {
    expect(fileChangedEvent('prj_1', 'docs/sub/a.md')).toEqual({
      type: 'fs.changed',
      projectId: 'prj_1',
      path: 'docs/sub',
      filePath: 'docs/sub/a.md',
    });
  });
});

describe('broadcastFileChanged（AI 侧落盘后广播）', () => {
  it('绝对路径反查到项目 → 广播项目相对的 fs.changed（带 path + filePath）', async () => {
    findProjectByPath.mockResolvedValue({ id: 'prj_1', path: '/home/me/proj' });
    await broadcastFileChanged('/home/me/proj/docs/a.md');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0] as FsChangedEvent).toEqual({
      type: 'fs.changed',
      projectId: 'prj_1',
      path: 'docs',
      filePath: 'docs/a.md',
    });
  });

  it('绝对路径不属于任何已注册项目 → 静默不广播', async () => {
    findProjectByPath.mockResolvedValue(null);
    await broadcastFileChanged('/tmp/orphan.md');
    expect(broadcast).not.toHaveBeenCalled();
  });
});
