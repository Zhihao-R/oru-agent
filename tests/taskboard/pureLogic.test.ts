/**
 * taskboard 纯逻辑层单测——749 行主代码此前零 vitest、全押 smoke。这里把不依赖磁盘的
 * 纯函数（toMeta 字段剥离、resolve 三档项目解析）下沉到 vitest，快、隔离、覆盖 smoke 没钉的边界。
 */
import { describe, it, expect } from 'vitest';
import type { BoardTask } from '@shared/types';
import type { Project } from '@shared/types';
import { toMeta } from '../../electron/main/taskboard/store';
import { resolve } from '../../electron/main/taskboard/resolveProject';

const baseTask: BoardTask = {
  id: 'bt_1',
  ownerId: 'local-user',
  title: '任务',
  description: '长描述只在详情面板显示',
  status: '待办',
  assignee: 'you',
  createdAt: 1,
  updatedAt: 1,
  commentCount: 0,
  attachments: [{ relPath: 'x.png', width: 1, height: 1 }],
};

describe('toMeta', () => {
  it('剥掉 description / attachments，其余字段保留（列表行不泄漏详情字段）', () => {
    const meta = toMeta(baseTask);
    expect('description' in meta).toBe(false);
    expect('attachments' in meta).toBe(false);
    expect(meta.id).toBe('bt_1');
    expect(meta.title).toBe('任务');
    expect(meta.commentCount).toBe(0);
  });
});

const proj = (id: string, name: string, path: string): Project =>
  ({ id, name, path }) as Project;

describe('resolve（项目 tag 三档解析）', () => {
  const projects = [
    proj('p1', 'Oru', '/repos/oru'),
    proj('p2', '营销', '/repos/marketing'),
  ];

  it('① 完全匹配 name', () => {
    expect(resolve('Oru', projects)).toBe('p1');
  });
  it('② 大小写忽略匹配 name', () => {
    expect(resolve('oru', projects)).toBe('p1');
  });
  it('③ basename 匹配（完全 / 大小写忽略）', () => {
    expect(resolve('marketing', projects)).toBe('p2');
    expect(resolve('MARKETING', projects)).toBe('p2');
  });
  it('不命中 → null', () => {
    expect(resolve('不存在', projects)).toBeNull();
  });
  it('完全匹配多个 → null（歧义按无项目处理）', () => {
    const dup = [proj('a', 'X', '/one'), proj('b', 'X', '/two')];
    expect(resolve('X', dup)).toBeNull();
  });
});
