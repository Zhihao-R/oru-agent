/**
 * 工具断路器检测状态机（G01/G04）——连续失败 / 异常频繁两条跳闸判据。
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  noteToolCall,
  noteToolResult,
  evaluateTrip,
  resetBreaker,
  __clearBreakersForTest,
  CONSEC_FAILURE_LIMIT,
  RATE_LIMIT,
  RATE_WINDOW_MS,
} from '../../electron/main/agent/circuitBreaker';

afterEach(() => __clearBreakersForTest());

describe('circuitBreaker 检测（G01/G04）', () => {
  it('连续失败达上限即跳闸；中间一次成功清零', () => {
    const c = 'conv1';
    for (let i = 0; i < CONSEC_FAILURE_LIMIT - 1; i++) {
      noteToolCall(c, i);
      noteToolResult(c, true);
      expect(evaluateTrip(c)).toBeNull();
    }
    // 差一次到上限：再来一次成功 → 清零，不跳
    noteToolCall(c, 100);
    noteToolResult(c, false);
    expect(evaluateTrip(c)).toBeNull();
    // 重新连续失败到上限 → 跳
    for (let i = 0; i < CONSEC_FAILURE_LIMIT; i++) {
      noteToolCall(c, 200 + i);
      noteToolResult(c, true);
    }
    expect(evaluateTrip(c)).toBe('consecutive-failures');
  });

  it('窗口内调用达上限即跳闸（高频）', () => {
    const c = 'conv2';
    const t0 = 1_000_000;
    for (let i = 0; i < RATE_LIMIT - 1; i++) {
      noteToolCall(c, t0 + i * 10); // 全在窗口内
      noteToolResult(c, false); // 都成功，排除连续失败干扰
    }
    expect(evaluateTrip(c)).toBeNull();
    noteToolCall(c, t0 + RATE_LIMIT * 10);
    expect(evaluateTrip(c)).toBe('high-frequency');
  });

  it('调用散落在窗口之外不算高频（老调用被汰换）', () => {
    const c = 'conv3';
    // 每次间隔大于窗口 → 窗口内始终只有 1 次
    for (let i = 0; i < RATE_LIMIT + 5; i++) {
      noteToolCall(c, i * (RATE_WINDOW_MS + 1));
      noteToolResult(c, false);
      expect(evaluateTrip(c)).toBeNull();
    }
  });

  it('resetBreaker 清零，跳闸后「继续放行」能接着跑', () => {
    const c = 'conv4';
    for (let i = 0; i < CONSEC_FAILURE_LIMIT; i++) {
      noteToolCall(c, i);
      noteToolResult(c, true);
    }
    expect(evaluateTrip(c)).toBe('consecutive-failures');
    resetBreaker(c);
    expect(evaluateTrip(c)).toBeNull();
  });

  it('对话之间互不干扰', () => {
    for (let i = 0; i < CONSEC_FAILURE_LIMIT; i++) {
      noteToolCall('A', i);
      noteToolResult('A', true);
    }
    expect(evaluateTrip('A')).toBe('consecutive-failures');
    expect(evaluateTrip('B')).toBeNull();
  });
});
