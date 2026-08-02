/**
 * 组层 scope 过滤（review M2）回归：多规则组「一活一满」不被拆进 active/ended 两区。
 * 谓词 isGroupActive/isGroupEnded 是服务端 scope 过滤与前端清单分档共用的承重 parity 逻辑。
 */
import { describe, expect, it } from 'vitest';
import type { TaskGroup, TaskGroupRule } from '@shared/types';
import { filterGroupsByScope } from '../../electron/main/scheduledTasks/rpc';
import { isGroupActive, isGroupEnded } from '@shared/scheduledTasks/group';

function rule(over: Partial<TaskGroupRule> = {}): TaskGroupRule {
  return { taskId: 't', spec: { kind: 'daily', minutesOfDay: 480 }, nextRunAt: 1000, enabled: true, ...over };
}
function group(over: Partial<TaskGroup> = {}): TaskGroup {
  return {
    groupId: 'g',
    title: 't',
    prompt: 'p',
    runLocation: { kind: 'newConversation' },
    createdBy: 'user',
    enabled: true,
    rules: [rule()],
    nextRunAt: 1000,
    runHistory: [],
    createdAt: 0,
    ...over,
  };
}

describe('filterGroupsByScope · 组层过滤', () => {
  it('一活一满的组：算 active、不算 ended（不被拆两区）', () => {
    const g = group({
      groupId: 'mix',
      rules: [rule({ taskId: 'a', nextRunAt: 5000 }), rule({ taskId: 'b', nextRunAt: null, enabled: false })],
    });
    expect(isGroupActive(g)).toBe(true);
    expect(isGroupEnded(g)).toBe(false);
    expect(filterGroupsByScope([g], 'active').map((x) => x.groupId)).toEqual(['mix']);
    expect(filterGroupsByScope([g], 'ended')).toEqual([]);
  });

  it('全部规则终结 → ended；含任一活游标 → active', () => {
    const dead = group({ groupId: 'd', rules: [rule({ nextRunAt: null }), rule({ nextRunAt: null })] });
    expect(isGroupEnded(dead)).toBe(true);
    expect(filterGroupsByScope([dead], 'ended').map((x) => x.groupId)).toEqual(['d']);
    expect(filterGroupsByScope([dead], 'active')).toEqual([]);
  });

  it('整组暂停（游标仍在）留在 active——与单条暂停任务 parity', () => {
    // 组内规则都 enabled=false 但 nextRunAt 未清（暂停不清游标）→ 仍活跃，前端显示「已暂停」
    const paused = group({
      groupId: 'p',
      enabled: false,
      nextRunAt: null, // enabled 过滤后无活跃规则 → 组 nextRunAt null
      rules: [rule({ enabled: false, nextRunAt: 5000 })],
    });
    expect(isGroupActive(paused)).toBe(true);
    expect(filterGroupsByScope([paused], 'active').map((x) => x.groupId)).toEqual(['p']);
    expect(filterGroupsByScope([paused], 'ended')).toEqual([]);
  });

  it('missed scope 按组 missedAt', () => {
    const m = group({ groupId: 'm', missedAt: 999 });
    const n = group({ groupId: 'n' });
    expect(filterGroupsByScope([m, n], 'missed').map((x) => x.groupId)).toEqual(['m']);
  });
});
