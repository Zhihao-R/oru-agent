/**
 * buildMergeAssemblyNotice（S09 · G70）——回合末合并装配标注的纯函数验证。
 */
import { describe, it, expect } from 'vitest';
import { buildMergeAssemblyNotice } from '../../electron/main/agent/mergeAssembly';
import type { SteeringMsg } from '../../electron/main/agent/steeringQueue';
import type { TurnTriggerType } from '@shared/types';

function msg(trigger: TurnTriggerType, text = 't'): SteeringMsg {
  return { clientMsgId: `c-${text}`, serverId: `s-${text}`, text, trigger };
}

describe('buildMergeAssemblyNotice', () => {
  it('单条 user → undefined（平凡续跑无需标注）', () => {
    expect(buildMergeAssemblyNotice([msg('user')])).toBeUndefined();
  });

  it('单条 scheduled → undefined（触发卡已在历史）', () => {
    expect(buildMergeAssemblyNotice([msg('scheduled')])).toBeUndefined();
  });

  it('空批 → undefined', () => {
    expect(buildMergeAssemblyNotice([])).toBeUndefined();
  });

  it('多条混合 → 带「本轮新输入共 N 条」+ 分类型分角色', () => {
    const notice = buildMergeAssemblyNotice([msg('user', 'u1'), msg('user', 'u2'), msg('scheduled', 'sch')]);
    expect(notice).toContain('本轮新输入共 3 条');
    expect(notice).toContain('用户补充 2 条');
    expect(notice).toContain('定时任务触发 1 条');
  });

  it('单条 task-completed → 产出 notice 并随附播报 nudge（不落气泡故必须经此到达模型）', () => {
    const nudge = '(System trigger: announce the finished task)';
    const notice = buildMergeAssemblyNotice([msg('task-completed', nudge)]);
    expect(notice).toBeDefined();
    expect(notice).toContain('后台任务已完成 1 项');
    expect(notice).toContain(nudge);
  });

  it('task-completed 与 user 合并 → 两种角色都框定，且带 nudge', () => {
    const nudge = '(System trigger: announce)';
    const notice = buildMergeAssemblyNotice([msg('user', 'u'), msg('task-completed', nudge)]);
    expect(notice).toContain('本轮新输入共 2 条');
    expect(notice).toContain('用户补充 1 条');
    expect(notice).toContain('后台任务已完成 1 项');
    expect(notice).toContain(nudge);
  });
});
