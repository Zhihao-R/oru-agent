/**
 * 时间换算原子（shared/scheduledTasks/timeAtoms）——纯函数、注入 now、严格解析。
 *
 * 核心回归：越界输入必须 throw，绝不能像 `new Date(2026,12,5)` 那样静默翻滚成合法的错日期
 * ——那正是「设了个合法但错误的未来时刻、过得了所有闸」病灶的根源。
 */
import { describe, it, expect } from 'vitest';
import {
  hhmmToMinutes,
  parseLocalDateTime,
  afterToMs,
  weekdayToNumber,
} from '@shared/scheduledTasks/timeAtoms';

describe('hhmmToMinutes', () => {
  it('08:00 → 480、18:30 → 1110、00:00 → 0、23:59 → 1439', () => {
    expect(hhmmToMinutes('08:00')).toBe(480);
    expect(hhmmToMinutes('18:30')).toBe(1110);
    expect(hhmmToMinutes('00:00')).toBe(0);
    expect(hhmmToMinutes('23:59')).toBe(1439);
  });
  it('越界 throw：25:00（时>23）/ 08:60（分>59）', () => {
    expect(() => hhmmToMinutes('25:00')).toThrow();
    expect(() => hhmmToMinutes('08:60')).toThrow();
  });
  it('格式错 throw：缺冒号 / 非数字 / 空串', () => {
    expect(() => hhmmToMinutes('0800')).toThrow();
    expect(() => hhmmToMinutes('ab:cd')).toThrow();
    expect(() => hhmmToMinutes('')).toThrow();
  });
});

describe('parseLocalDateTime', () => {
  it('2026-06-29 + 18:00 → 本地 6/29 18:00 的时间戳', () => {
    expect(parseLocalDateTime('2026-06-29', '18:00')).toBe(
      new Date(2026, 5, 29, 18, 0, 0, 0).getTime(),
    );
  });
  it('闰年 2/29 合法', () => {
    expect(parseLocalDateTime('2024-02-29', '00:00')).toBe(
      new Date(2024, 1, 29, 0, 0, 0, 0).getTime(),
    );
  });
  it('关键回归：2026-13-05 越界月份 throw，绝不静默翻滚成 2027-01-05', () => {
    expect(() => parseLocalDateTime('2026-13-05', '18:00')).toThrow();
  });
  it('关键回归：2026-02-30 不存在的日 throw，绝不翻滚成 3 月', () => {
    expect(() => parseLocalDateTime('2026-02-30', '18:00')).toThrow();
  });
  it('非闰年 2/29 throw', () => {
    expect(() => parseLocalDateTime('2026-02-29', '00:00')).toThrow();
  });
  it('日 0 / 月 0 throw', () => {
    expect(() => parseLocalDateTime('2026-00-10', '00:00')).toThrow();
    expect(() => parseLocalDateTime('2026-06-00', '00:00')).toThrow();
  });
  it('格式错 throw：非 YYYY-MM-DD / 时间越界', () => {
    expect(() => parseLocalDateTime('2026/06/29', '18:00')).toThrow();
    expect(() => parseLocalDateTime('2026-06-29', '25:00')).toThrow();
  });
});

describe('afterToMs', () => {
  const NOW = new Date(2026, 5, 29, 14, 45, 30, 123).getTime();
  it('minute / hour 用毫秒算术', () => {
    expect(afterToMs(45, 'minute', NOW)).toBe(NOW + 45 * 60_000);
    expect(afterToMs(3, 'hour', NOW)).toBe(NOW + 3 * 3_600_000);
  });
  it('day 用 Date 组件 +N 天（保留时分秒，DST 安全）', () => {
    const d = new Date(NOW);
    expect(afterToMs(3, 'day', NOW)).toBe(
      new Date(d.getFullYear(), d.getMonth(), d.getDate() + 3, d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()).getTime(),
    );
  });
});

describe('weekdayToNumber', () => {
  it('sun=0 … sat=6', () => {
    expect(weekdayToNumber('sun')).toBe(0);
    expect(weekdayToNumber('mon')).toBe(1);
    expect(weekdayToNumber('tue')).toBe(2);
    expect(weekdayToNumber('wed')).toBe(3);
    expect(weekdayToNumber('thu')).toBe(4);
    expect(weekdayToNumber('fri')).toBe(5);
    expect(weekdayToNumber('sat')).toBe(6);
  });
  it('未知名字 throw', () => {
    expect(() => weekdayToNumber('funday' as never)).toThrow();
  });
});
