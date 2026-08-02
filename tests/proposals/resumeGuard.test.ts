/**
 * 续跑单飞守卫（决策 5）——验"整批才续一次" + "并发双触发只取一个令牌"。
 */
import { describe, expect, it } from 'vitest';
import { acquireResume, releaseResume } from '../../electron/main/proposals/resumeGuard';

describe('resumeGuard', () => {
  it('还有 pending（>0）→ 拿不到令牌（整批没处理完不续）', () => {
    expect(acquireResume('c-pending', 1)).toBe(false);
    expect(acquireResume('c-pending', 3)).toBe(false);
  });

  it('pending=0 → 拿到令牌；占位期间并发再取同一会话 → 拿不到（防双触发起两轮）', () => {
    expect(acquireResume('c1', 0)).toBe(true);
    // 模拟第二个 maybeResumeTurn 几乎同时进来、同样读到 0 pending
    expect(acquireResume('c1', 0)).toBe(false);
    // 释放后可再取（下一批）
    releaseResume('c1');
    expect(acquireResume('c1', 0)).toBe(true);
    releaseResume('c1');
  });

  it('不同会话各自独立占位', () => {
    expect(acquireResume('cA', 0)).toBe(true);
    expect(acquireResume('cB', 0)).toBe(true);
    expect(acquireResume('cA', 0)).toBe(false);
    releaseResume('cA');
    releaseResume('cB');
  });
});
